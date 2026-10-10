import path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseAllDocuments,
  parseDocument,
} from "yaml";

import {
  containerDocumentImages,
  isComposeDefinitionPath,
  isKubernetesDefinitionPath,
} from "./toolchain-container-inputs";
import {
  engineFloorSelectorMatches,
  type ResolvedEngineFloor,
} from "./toolchain-engine-floors";
import { canonicalDockerRuntime } from "./toolchain-images";
import {
  githubAutomationFileKind,
  isMiseConfigPath,
  isDockerDefinitionPath,
} from "./toolchain-inputs";
import { nodeSelectorMatches } from "./toolchain-node";

export const runtimeRules = [
  "bun-pins",
  "node-version",
  "python-version",
  "rust-version",
  "runtime-manager",
  "runtime-docker",
  "runtime-workflow",
  "action-pins",
] as const;

type RuntimeRule = (typeof runtimeRules)[number];

type RuntimePolicy = {
  node: string;
  python: string;
  rust: string;
  rustCompilerDevelopment: string;
  bun: string;
  packages: Record<string, string>;
  actions: Record<string, { sha: string; version: string }>;
};

type RuntimeDiagnostic = {
  rule: RuntimeRule;
  path: string;
  line: number;
  message: string;
};

export type RuntimeDelegation = {
  path: string;
  line: number;
  tool: "node" | "python" | "bun";
  selector: string;
  checkoutPath: string;
  ref: string;
};

type CheckRuntimeFileOptions = {
  file: string;
  text: string;
  policy: RuntimePolicy;
  trackedFiles: ReadonlySet<string>;
  readFile: (file: string) => string | undefined;
  repository?: string | undefined;
  onDelegated?: ((report: RuntimeDelegation) => void) | undefined;
  engineFloors?: readonly ResolvedEngineFloor[] | undefined;
  onEngineFloor?:
    | ((floor: ResolvedEngineFloor, status: "matched" | "mismatch") => void)
    | undefined;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pythonSelectorMatches = (value: unknown, expected: string) =>
  value === expected ||
  (typeof value === "string" &&
    /^\d+\.\d+$/.test(expected) &&
    value.startsWith(`${expected}.`) &&
    /^\d+\.\d+\.\d+$/.test(value));

const compareRelease = (left: readonly number[], right: readonly number[]) => {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left.at(index) ?? 0) - (right.at(index) ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
};

/** A minor policy covers every nonnegative patch in that release series. */
type PythonSeriesRequirementOptions = {
  current: readonly number[];
  operator: string;
  target: readonly number[];
  wildcard: boolean;
};
const pythonSeriesRequirementMatches = ({
  current,
  operator,
  target,
  wildcard,
}: PythonSeriesRequirementOptions) => {
  const prefixCovers = (prefix: readonly number[]) =>
    prefix.length <= 2 &&
    prefix.every((part, index) => current.at(index) === part);
  const prefixOverlaps =
    target.slice(0, 2).every((part, index) => current.at(index) === part) &&
    target.slice(3).every((part) => part === 0);
  if (wildcard) {
    if (operator === "==") return prefixCovers(target);
    if (operator === "!=") return !prefixOverlaps;
    return false;
  }
  const minimumComparison = compareRelease(current, target);
  const seriesComparison = compareRelease(
    current.slice(0, 2),
    target.slice(0, 2),
  );
  switch (operator) {
    case "==":
      return false;
    case "!=":
      return !(
        seriesComparison === 0 && target.slice(3).every((part) => part === 0)
      );
    case ">=":
      return minimumComparison >= 0;
    case ">":
      return minimumComparison > 0;
    case "<=":
    case "<":
      return seriesComparison < 0;
    case "~=":
      return (
        target.length >= 2 &&
        minimumComparison >= 0 &&
        prefixCovers(target.slice(0, -1))
      );
    default:
      return false;
  }
};

/** Evaluate final-release Python constraints against the complete selected version set. */
const pythonRequirementMatches = (requirement: unknown, version: string) => {
  if (typeof requirement !== "string" || requirement.trim() === "")
    return false;
  const current = version.split(".").map(Number);
  return requirement.split(",").every((clause) => {
    const match = /^(~=|==|!=|<=|>=|<|>)\s*(\d+(?:\.\d+)*)(\.\*)?$/.exec(
      clause.trim(),
    );
    if (match === null) return false;
    const operator = match[1];
    const release = match[2];
    if (release === undefined || operator === undefined) return false;
    const target = release.split(".").map(Number);
    if (current.length === 2)
      return pythonSeriesRequirementMatches({
        current,
        operator,
        target,
        wildcard: match[3] !== undefined,
      });
    const comparison = compareRelease(current, target);
    if (match[3] !== undefined) {
      if (operator !== "==" && operator !== "!=") return false;
      const prefix = target.every(
        (part, index) => (current.at(index) ?? 0) === part,
      );
      return operator === "==" ? prefix : !prefix;
    }
    switch (operator) {
      case "==":
        return comparison === 0;
      case "!=":
        return comparison !== 0;
      case "<=":
        return comparison <= 0;
      case ">=":
        return comparison >= 0;
      case "<":
        return comparison < 0;
      case ">":
        return comparison > 0;
      case "~=": {
        if (target.length < 2) return false;
        const prefix = target.slice(0, -1);
        return (
          comparison >= 0 &&
          prefix.every((part, index) => (current.at(index) ?? 0) === part)
        );
      }
      default:
        return false;
    }
  });
};

/** Check runtime declarations only in the files that declare or configure them. */
export const checkRuntimeFile = ({
  file,
  text,
  policy,
  trackedFiles,
  readFile,
  repository,
  onDelegated,
  engineFloors = [],
  onEngineFloor,
}: CheckRuntimeFileOptions): RuntimeDiagnostic[] => {
  const diagnostics: RuntimeDiagnostic[] = [];
  const name = path.posix.basename(file);
  const lines = text.split(/\r?\n/);
  type RuntimeDiagnosticOptions = Pick<
    RuntimeDiagnostic,
    "rule" | "line" | "message"
  >;
  const add = ({ rule, line, message }: RuntimeDiagnosticOptions) => {
    diagnostics.push({ rule, path: file, line, message });
  };
  const lineOf = (key: string) =>
    Math.max(1, lines.findIndex((line) => line.includes(key)) + 1);
  type RuntimePinOptions = {
    rule: RuntimeRule;
    value: unknown;
    expected: string;
    label: string;
    line?: number;
    selector?: "node" | undefined;
  };
  const pin = ({
    rule,
    value,
    expected,
    label,
    line = 1,
    selector,
  }: RuntimePinOptions) => {
    let matches = value === expected;
    if (selector === "node") matches = nodeSelectorMatches(value, expected);
    else if (label.includes("python"))
      matches = pythonSelectorMatches(value, expected);
    if (!matches)
      add({
        rule,
        line,
        message: `${label} must be ${expected}, found ${String(value)}`,
      });
  };
  const toml = (rule: RuntimeRule) => {
    try {
      return parseToml(text);
    } catch {
      add({
        rule,
        line: 1,
        message: "invalid TOML",
      });
      return undefined;
    }
  };
  const versions = {
    ...policy.packages,
    ...Object.fromEntries(
      Object.entries(policy.packages).map(([tool, version]) => [
        `npm:${tool}`,
        version,
      ]),
    ),
    bun: policy.bun,
    node: policy.node,
    nodejs: policy.node,
    python: policy.python,
    rust: policy.rust,
    "core:node": policy.node,
    "core:python": policy.python,
    "core:rust": policy.rust,
    "core:bun": policy.bun,
  };
  const nodeTools = new Set(["node", "nodejs", "core:node"]);
  if (name === ".bun-version")
    pin({
      rule: "bun-pins",
      value: text.trim(),
      expected: policy.bun,
      label: name,
    });
  if (name === ".node-version" || name === ".nvmrc")
    pin({
      rule: "node-version",
      selector: "node",
      value: text.trim(),
      expected: policy.node,
      label: name,
    });
  if (name === ".python-version")
    pin({
      rule: "python-version",
      value: text.trim(),
      expected: policy.python,
      label: name,
    });
  const firstContent = lines.find(
    (line) => line.trim() !== "" && !line.trimStart().startsWith("#"),
  );
  const rustToml =
    name === "rust-toolchain.toml" ||
    (name === "rust-toolchain" && firstContent?.trimStart().startsWith("["));
  if (name === "rust-toolchain" && !rustToml)
    pin({
      rule: "rust-version",
      value: text.trim(),
      expected: policy.rust,
      label: name,
    });
  if (rustToml) {
    const parsed = toml("rust-version");
    if (parsed !== undefined) {
      const toolchain = parsed["toolchain"];
      const components = record(toolchain)
        ? toolchain["components"]
        : undefined;
      const expected =
        Array.isArray(components) && components.includes("rustc-dev")
          ? policy.rustCompilerDevelopment
          : policy.rust;
      pin({
        rule: "rust-version",
        value: record(toolchain) ? toolchain["channel"] : undefined,
        expected,
        label: "Rust channel",
        line: lineOf("channel"),
      });
    }
  }
  if (name === "Cargo.toml") {
    const parsed = toml("rust-version");
    const rustFloor = (value: unknown) => {
      const parts =
        typeof value === "string" &&
        /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/.test(value)
          ? value.split(".").map(Number)
          : undefined;
      if (
        parts === undefined ||
        !parts.every(Number.isSafeInteger) ||
        compareRelease(parts, policy.rust.split(".").map(Number)) > 0
      )
        add({
          rule: "rust-version",
          line: lineOf("rust-version"),
          message: `Cargo rust-version must be a bare support floor at or below Rust ${policy.rust}`,
        });
    };
    const readManifest = (candidate: string) => {
      if (candidate === file) return parsed;
      if (!trackedFiles.has(candidate)) return undefined;
      try {
        return parseToml(readFile(candidate) ?? "");
      } catch {
        return undefined;
      }
    };
    if (parsed !== undefined) {
      const workspace = parsed["workspace"];
      const defaults = record(workspace) ? workspace["package"] : undefined;
      if (record(defaults) && defaults["rust-version"] !== undefined)
        rustFloor(defaults["rust-version"]);
      const pkg = parsed["package"];
      const version = record(pkg) ? pkg["rust-version"] : undefined;
      if (version !== undefined) {
        if (!record(version)) rustFloor(version);
        else {
          let inherited: unknown;
          if (version["workspace"] === true && record(pkg)) {
            const explicit = pkg["workspace"];
            let directory = path.posix.dirname(file);
            const explicitPath =
              typeof explicit === "string" &&
              !explicit.includes("\\") &&
              !explicit.includes(":") &&
              !explicit.includes("${{") &&
              !path.posix.isAbsolute(explicit)
                ? path.posix.normalize(path.posix.join(directory, explicit))
                : undefined;
            if (
              explicit === undefined ||
              (explicitPath !== undefined &&
                explicitPath !== ".." &&
                !explicitPath.startsWith("../"))
            ) {
              if (explicitPath !== undefined) directory = explicitPath;
              while (true) {
                const owner = readManifest(
                  path.posix.join(directory, "Cargo.toml"),
                );
                const table = owner?.["workspace"];
                if (record(table)) {
                  const fields = table["package"];
                  inherited = record(fields)
                    ? fields["rust-version"]
                    : undefined;
                  break;
                }
                if (explicit !== undefined || directory === ".") break;
                directory = path.posix.dirname(directory);
              }
            }
          }
          rustFloor(inherited);
        }
      }
    }
  }
  if (name === "Pipfile") {
    const parsed = toml("python-version");
    const requires = parsed?.["requires"];
    if (record(requires)) {
      const minor = requires["python_version"];
      if (
        minor !== undefined &&
        minor !== policy.python.split(".").slice(0, 2).join(".")
      )
        add({
          rule: "python-version",
          line: lineOf("python_version"),
          message: `Pipfile python_version must select Python ${policy.python}`,
        });
      const full = requires["python_full_version"];
      if (
        full !== undefined &&
        !(
          typeof full === "string" &&
          /^\d+\.\d+\.\d+$/.test(full) &&
          pythonSelectorMatches(full, policy.python)
        )
      )
        add({
          rule: "python-version",
          line: lineOf("python_full_version"),
          message: `Pipfile python_full_version must select Python ${policy.python}`,
        });
    }
  }
  if (name === "pyproject.toml" || name === "uv.toml") {
    const parsed = toml("python-version");
    if (parsed !== undefined) {
      const project = parsed["project"];
      if (record(project) && project["requires-python"] !== undefined)
        if (
          !pythonRequirementMatches(project["requires-python"], policy.python)
        )
          add({
            rule: "python-version",
            line: lineOf("requires-python"),
            message: `requires-python must include Python ${policy.python}; unsupported constraints must use final-release version specifiers`,
          });
      const tool = parsed["tool"];
      const configuredUv = record(tool) ? tool["uv"] : undefined;
      const uv = name === "uv.toml" ? parsed : configuredUv;
      if (record(uv) && uv["python"] !== undefined)
        pin({
          rule: "python-version",
          value: uv["python"],
          expected: policy.python,
          label: "uv python",
          line: lineOf("python"),
        });
    }
  }
  if (isMiseConfigPath(file)) {
    const parsed = toml("runtime-manager");
    const tools = parsed?.["tools"];
    if (record(tools)) {
      for (const [tool, expected] of Object.entries(versions)) {
        const configured = tools[tool];
        if (configured !== undefined)
          pin({
            rule: "runtime-manager",
            value: record(configured) ? configured["version"] : configured,
            expected,
            selector: nodeTools.has(tool) ? "node" : undefined,
            label: `mise ${tool}`,
            line: lineOf(tool),
          });
      }
    }
  }
  if (name === ".tool-versions") {
    lines.forEach((line, index) => {
      const fields = line.replace(/#.*$/, "").trim().split(/\s+/);
      const tool = fields.at(0);
      if (tool === undefined || !(tool in versions)) return;
      const expected = Object.entries(versions).find(
        ([key]) => key === tool,
      )?.[1];
      if (expected !== undefined)
        pin({
          rule: "runtime-manager",
          value: fields.slice(1).join(" "),
          expected,
          selector: nodeTools.has(tool) ? "node" : undefined,
          label: `.tool-versions ${tool}`,
          line: index + 1,
        });
    });
  }
  type RuntimeImageOptions = {
    image: unknown;
    line: number;
    label: string;
  };
  const checkRuntimeImage = ({ image, line, label }: RuntimeImageOptions) => {
    if (typeof image !== "string" || image.includes("$")) {
      add({
        rule: "runtime-docker",
        line,
        message: `cannot determine ${label} runtime; use a static image or a reasoned runtime-docker opt-out`,
      });
      return;
    }
    const runtime = /^(node|python|oven\/bun)(?::([^@]+))?(?:@.*)?$/i.exec(
      canonicalDockerRuntime(image),
    );
    if (runtime === null) return;
    const tool = runtime[1]?.toLowerCase();
    if (image.includes("@")) {
      add({
        rule: tool === "oven/bun" ? "bun-pins" : "runtime-docker",
        line,
        message: `${label} ${tool} digest requires an approved digest policy; use a tag-only runtime image`,
      });
      return;
    }
    const tag = runtime[2];
    const variantSuffix =
      tool === "oven/bun"
        ? /-(?:alpine|slim|debian)$/
        : /-(?:alpine(?:\d+(?:\.\d+)*)?|(?:bookworm|bullseye|trixie|buster)(?:-slim)?|slim)$/;
    // Strip only supported image variants; prerelease qualifiers remain invalid pins.
    const version = tag?.replace(variantSuffix, "");
    let expected = policy.bun;
    if (tool === "node") expected = policy.node;
    else if (tool === "python") expected = policy.python;
    pin({
      rule: tool === "oven/bun" ? "bun-pins" : "runtime-docker",
      value: version,
      expected,
      selector: tool === "node" ? "node" : undefined,
      label: `${label} ${tool}`,
      line,
    });
  };
  if (isDockerDefinitionPath(file)) {
    const variables = new Map<string, string>();
    const escape = /^\s*#\s*escape\s*=\s*([\\`])\s*$/m.exec(text)?.[1] ?? "\\";
    const continuation = new RegExp(`${escape === "`" ? "`" : "\\\\"}\\s*$`);
    const stages = new Set<string>();
    let argumentScope: "global" | "stage" = "global";
    const heredocs: { delimiter: string; stripTabs: boolean; line: number }[] =
      [];
    let instruction = "";
    let startLine = 1;
    const expand = (value: string) => {
      for (let count = 0; count <= variables.size; count++) {
        const next = value.replace(
          /\$(?:\{([A-Za-z_][A-Za-z_\d]*)\}|([A-Za-z_][A-Za-z_\d]*))/g,
          (reference, braced: string | undefined, plain: string | undefined) =>
            variables.get(braced ?? plain ?? "") ?? reference,
        );
        if (next === value) return next;
        value = next;
      }
      return value;
    };
    const collectHeredocs = (content: string, line: number) => {
      let quote: "'" | '"' | undefined;
      for (let index = 0; index < content.length; index++) {
        const character = content.at(index);
        if (quote !== undefined) {
          if (character === quote) quote = undefined;
          else if (quote === '"' && character === "\\") index++;
          continue;
        }
        if (character === "\\") {
          index++;
          continue;
        }
        if (character === "'" || character === '"') {
          quote = character;
          continue;
        }
        if (
          character === "#" &&
          (index === 0 || /[\s;&|()]/.test(content.at(index - 1) ?? ""))
        )
          break;
        if (character !== "<" || content.at(index + 1) !== "<") continue;
        if (content.at(index + 2) === "<") {
          index += 2;
          continue;
        }
        index += 2;
        const stripTabs = content.at(index) === "-";
        if (stripTabs) index++;
        while (/\s/.test(content.at(index) ?? "")) index++;
        if (content.at(index) === "#") {
          add({
            rule: "runtime-docker",
            line,
            message: "invalid Docker heredoc delimiter",
          });
          break;
        }
        let delimiter = "";
        let delimiterQuote: "'" | '"' | undefined;
        for (; index < content.length; index++) {
          const part = content.at(index);
          if (delimiterQuote !== undefined) {
            if (part === delimiterQuote) delimiterQuote = undefined;
            else if (
              delimiterQuote === '"' &&
              part === "\\" &&
              /[$"\\]/.test(content.at(index + 1) ?? "")
            )
              delimiter += content.at(++index);
            else delimiter += part;
            continue;
          }
          if (part === "'" || part === '"') {
            delimiterQuote = part;
            continue;
          }
          if (part === "\\" && content.at(index + 1) !== undefined) {
            delimiter += content.at(++index);
            continue;
          }
          if (/[\s;&|<>()]/.test(part ?? "")) break;
          delimiter += part;
        }
        if (delimiter !== "" && delimiterQuote === undefined)
          heredocs.push({ delimiter, stripTabs, line });
        else
          add({
            rule: "runtime-docker",
            line,
            message: "invalid Docker heredoc delimiter",
          });
        index--;
      }
    };
    const checkInstruction = (content: string, line: number) => {
      const argument = /^\s*ARG\s+([A-Za-z_][A-Za-z_\d]*)(?:=(.*))?$/i.exec(
        content,
      );
      if (argument !== null) {
        if (argumentScope === "stage") return;
        const key = argument[1];
        const value = argument[2];
        if (key !== undefined && value !== undefined)
          variables.set(key, expand(value.replace(/^(["'])(.*)\1$/, "$2")));
        return;
      }
      if (/^\s*(?:RUN|COPY)\s+/i.test(content)) {
        collectHeredocs(content, line);
        return;
      }
      const from =
        /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(
          content,
        );
      if (from === null || from[1] === undefined) return;
      argumentScope = "stage";
      const image = expand(from[1]);
      if (image.includes("$")) {
        add({
          rule: "runtime-docker",
          line,
          message:
            "cannot determine FROM runtime; declare an image ARG default or a reasoned runtime-docker opt-out",
        });
        return;
      }
      const stage = from[2]?.toLowerCase();
      const previousStage = stages.has(image.toLowerCase());
      if (stage !== undefined) stages.add(stage);
      if (previousStage) return;
      checkRuntimeImage({ image, line, label: "FROM" });
    };
    lines.forEach((line, index) => {
      const heredoc = heredocs.at(0);
      if (heredoc !== undefined) {
        if (
          (heredoc.stripTabs ? line.replace(/^\t+/, "") : line) ===
          heredoc.delimiter
        )
          heredocs.shift();
        return;
      }
      if (line.trimStart().startsWith("#")) return;
      if (instruction === "") startLine = index + 1;
      instruction += line.replace(continuation, " ");
      if (continuation.test(line)) return;
      checkInstruction(instruction, startLine);
      instruction = "";
    });
    if (instruction !== "") checkInstruction(instruction, startLine);
    for (const heredoc of heredocs)
      add({
        rule: "runtime-docker",
        line: heredoc.line,
        message: `unterminated Docker heredoc ${heredoc.delimiter}`,
      });
  }
  if (isComposeDefinitionPath(file) || isKubernetesDefinitionPath(file)) {
    const lineCounter = new LineCounter();
    for (const containerDocument of parseAllDocuments(text, {
      lineCounter,
      merge: true,
      uniqueKeys: true,
    })) {
      const contents = containerDocument.contents;
      const declaredResource =
        isMap(contents) &&
        isScalar(contents.get("apiVersion", true)) &&
        isScalar(contents.get("kind", true));
      const recognizedContainer =
        isComposeDefinitionPath(file) || declaredResource;
      if (containerDocument.errors.length > 0) {
        if (recognizedContainer)
          add({
            rule: "runtime-docker",
            line: 1,
            message: "invalid container YAML",
          });
        continue;
      }
      try {
        const classified = containerDocumentImages(
          containerDocument.toJS({ maxAliasCount: 100 }),
          file,
        );
        for (const entry of classified?.images ?? []) {
          const node = containerDocument.getIn(entry.path, true);
          const line =
            (isMap(node) || isScalar(node) || isSeq(node) || isAlias(node)) &&
            node.range !== undefined &&
            node.range !== null
              ? lineCounter.linePos(node.range[0]).line
              : 1;
          checkRuntimeImage({
            image: entry.image,
            line,
            label:
              classified?.ecosystem === "docker-compose"
                ? "Compose image"
                : "Kubernetes image",
          });
        }
      } catch {
        if (recognizedContainer)
          add({
            rule: "runtime-docker",
            line: 1,
            message: "invalid container YAML aliases",
          });
      }
    }
  }
  const automationKind = githubAutomationFileKind(file);
  if (automationKind === undefined) return diagnostics;
  const document = parseDocument(text, { uniqueKeys: true, merge: true });
  if (document.errors.length > 0) {
    add({
      rule: "runtime-workflow",
      line: 1,
      message: "invalid workflow YAML",
    });
    return diagnostics;
  }
  const nodeLine = (node: unknown) => {
    if (!record(node) || !Array.isArray(node["range"])) return 1;
    const offset: unknown = node["range"].at(0);
    return typeof offset === "number"
      ? text.slice(0, offset).split("\n").length
      : 1;
  };
  type SparseCheckout =
    | { mode: "all" }
    | { mode: "files"; paths: ReadonlySet<string> }
    | { mode: "invalid" };
  type CheckoutBinding = { path: string; sparse: SparseCheckout } & (
    | { source: "tracked" }
    | { source: "untrusted"; reason: string; line: number }
    | { source: "delegated"; ref: string }
  );
  let checkoutBindings: CheckoutBinding[] = [];
  let checkoutDestinations = new Map<string, number>();
  let unknownCheckoutDestination = false;
  const staticRepositoryPath = (value: unknown): value is string =>
    typeof value === "string" &&
    value !== "" &&
    !value.includes("${{") &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !path.posix.isAbsolute(value) &&
    !value.split("/").includes("..");
  const normalizeCheckoutPath = (prefix: string) =>
    path.posix.normalize(prefix).replace(/\/$/, "") || ".";
  type RuntimeReferenceOptions = {
    value: unknown;
    tool: "node" | "python" | "bun";
    line: number;
  };
  const checkReference = ({ value, tool, line }: RuntimeReferenceOptions) => {
    const selectors = {
      node: [".node-version", ".nvmrc"],
      python: [".python-version"],
      bun: ["package.json"],
    };
    const allowed = selectors[tool];
    const rule = tool === "bun" ? "bun-pins" : "runtime-workflow";
    const selector = staticRepositoryPath(value)
      ? path.posix.normalize(value)
      : undefined;
    const binding =
      selector === undefined
        ? undefined
        : checkoutBindings.findLast(
            (entry) =>
              entry.path === "." ||
              selector === entry.path ||
              selector.startsWith(`${entry.path}/`),
          );
    if (selector === undefined) {
      add({
        rule,
        line,
        message: `setup-${tool} must reference a tracked ${allowed.join(" or ")}`,
      });
      return;
    }
    if (
      unknownCheckoutDestination ||
      [...checkoutDestinations].some(
        ([prefix, count]) =>
          count > 1 &&
          (prefix === "." ||
            selector === prefix ||
            selector.startsWith(`${prefix}/`)),
      )
    ) {
      add({
        rule,
        line,
        message: `setup-${tool} version-file selector has untrusted checkout provenance: checkout destinations must be static and have exactly one writer`,
      });
      return;
    }
    if (binding?.source === "untrusted") {
      add({
        rule,
        line: binding.line,
        message: `setup-${tool} version-file selector cannot use this checkout: ${binding.reason}`,
      });
      return;
    }
    const target =
      binding === undefined || binding.path === "."
        ? selector
        : path.posix.relative(binding.path, selector);
    if (
      !allowed.includes(path.posix.basename(target)) ||
      (binding?.source !== "delegated" && !trackedFiles.has(target))
    ) {
      add({
        rule,
        line,
        message: `setup-${tool} must reference a tracked ${allowed.join(" or ")}`,
      });
      return;
    }
    if (
      binding !== undefined &&
      (binding.sparse.mode === "invalid" ||
        (binding.sparse.mode === "files" && !binding.sparse.paths.has(target)))
    ) {
      add({
        rule,
        line,
        message: `checkout sparse-checkout must explicitly list ${target} without dynamic, glob, or negation patterns`,
      });
      return;
    }
    if (binding?.source === "delegated" && selector !== undefined) {
      onDelegated?.({
        path: file,
        line,
        tool,
        selector,
        checkoutPath: binding.path,
        ref: binding.ref,
      });
      return;
    }
    const content = readFile(target);
    if (tool === "bun") {
      try {
        const manifest: unknown = JSON.parse(content ?? "");
        pin({
          rule,
          value: record(manifest) ? manifest["packageManager"] : undefined,
          expected: `bun@${policy.bun}`,
          label: "setup-bun version file packageManager",
          line,
        });
      } catch {
        add({
          rule,
          line,
          message:
            "bun-version-file must reference a readable package.json object",
        });
      }
      return;
    }
    pin({
      rule,
      value: content?.trim(),
      expected: policy[tool],
      selector: tool === "node" ? "node" : undefined,
      label: `setup-${tool} version file`,
      line,
    });
  };
  const resolveNode = (node: unknown) => {
    const visited = new Set<unknown>();
    while (isAlias(node)) {
      if (visited.has(node)) throw new Error("cyclic YAML alias");
      visited.add(node);
      node = node.resolve(document);
    }
    return node;
  };
  const approvedActions = new Map(
    Object.entries(policy.actions).map(([action, approved]) => [
      action.toLowerCase(),
      approved,
    ]),
  );
  const mergedMaps = (node: unknown) => {
    node = resolveNode(node);
    if (!isMap(node)) return [];
    const maps: unknown[] = [];
    for (const pair of node.items) {
      if (
        !isScalar(pair.key) ||
        typeof pair.key.value !== "symbol" ||
        pair.key.source !== "<<"
      )
        continue;
      const merge = resolveNode(pair.value);
      maps.push(...(isSeq(merge) ? merge.items : [merge]));
    }
    return maps;
  };
  const keysOf = (node: unknown, visited = new Set<unknown>()): Set<string> => {
    node = resolveNode(node);
    if (!isMap(node)) return new Set();
    if (visited.has(node)) throw new Error("cyclic YAML merge");
    const next = new Set(visited);
    next.add(node);
    const keys = new Set(
      node.items.flatMap((pair) =>
        isScalar(pair.key) && typeof pair.key.value === "string"
          ? [pair.key.value]
          : [],
      ),
    );
    for (const merged of mergedMaps(node))
      for (const key of keysOf(merged, next)) keys.add(key);
    return keys;
  };
  type SourceMapOptions = {
    node: unknown;
    key: string;
    visited?: ReadonlySet<unknown>;
  };
  const sourceMap = ({
    node,
    key,
    visited = new Set(),
  }: SourceMapOptions): unknown => {
    node = resolveNode(node);
    if (!isMap(node)) return undefined;
    if (node.has(key)) return node;
    if (visited.has(node)) throw new Error("cyclic YAML merge");
    const next = new Set(visited);
    next.add(node);
    for (const merged of mergedMaps(node)) {
      const source = sourceMap({ node: merged, key, visited: next });
      if (source !== undefined) return source;
    }
    return undefined;
  };
  const getNode = (node: unknown, key: string) => {
    const source = sourceMap({ node, key });
    return isMap(source) ? resolveNode(source.get(key, true)) : undefined;
  };
  const actionInputs = new Map<unknown, Map<string, unknown>>();
  const inputsOf = (node: unknown) => {
    node = resolveNode(node);
    const cached = actionInputs.get(node);
    if (cached !== undefined) return cached;
    const options = getNode(node, "with");
    const inputs = new Map<string, unknown>();
    for (const key of keysOf(options)) {
      const folded = key.toUpperCase();
      const value = getNode(options, key);
      if (inputs.has(folded))
        add({
          rule: "action-pins",
          line: nodeLine(value),
          message: `action input ${key} collides after case-folding`,
        });
      if (
        /(?:^|-)VERSION(?:-FILE)?$/.test(folded) &&
        key !== folded.toLowerCase()
      )
        add({
          rule: "action-pins",
          line: nodeLine(value),
          message: `selector input ${key} must use canonical lowercase casing`,
        });
      inputs.set(folded, value);
    }
    actionInputs.set(node, inputs);
    return inputs;
  };
  const getInput = (node: unknown, key: string) =>
    inputsOf(node).get(key.toUpperCase());
  const dynamicRefBody = (value: unknown) => {
    if (typeof value !== "string" || !value.startsWith("${{")) return undefined;
    let quote: "'" | '"' | undefined;
    for (let index = 3; index < value.length; index++) {
      const character = value.at(index);
      if (quote !== undefined) {
        if (character === quote) {
          if (quote === "'" && value.at(index + 1) === "'") index++;
          else quote = undefined;
        } else if (quote === '"' && character === "\\") index++;
        continue;
      }
      if (character === "'" || character === '"') quote = character;
      else if (value.startsWith("${{", index)) return undefined;
      else if (character === "}" && value.at(index + 1) === "}")
        return index === value.length - 2
          ? value.slice(3, index).trim()
          : undefined;
    }
    return undefined;
  };
  const checkoutPrefixOf = (node: unknown) => {
    const destination = getInput(node, "path");
    if (destination === undefined) return ".";
    return isScalar(destination) ? destination.value : undefined;
  };
  const sparseCheckoutOf = (node: unknown): SparseCheckout => {
    const sparseKeys = [...inputsOf(node).keys()].filter((key) =>
      key.startsWith("SPARSE-CHECKOUT"),
    );
    if (sparseKeys.length === 0) return { mode: "all" };
    if (
      sparseKeys.some(
        (key) =>
          key !== "SPARSE-CHECKOUT" && key !== "SPARSE-CHECKOUT-CONE-MODE",
      )
    )
      return { mode: "invalid" };
    const value = getInput(node, "sparse-checkout");
    const cone = getInput(node, "sparse-checkout-cone-mode");
    if (
      !isScalar(value) ||
      typeof value.value !== "string" ||
      (cone !== undefined &&
        (!isScalar(cone) ||
          (cone.value !== true &&
            cone.value !== false &&
            cone.value !== "true" &&
            cone.value !== "false")))
    )
      return { mode: "invalid" };
    const paths = value.value
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (
      paths.length === 0 ||
      paths.some(
        (entry) =>
          !staticRepositoryPath(entry) ||
          entry.startsWith("!") ||
          /[*?[\]]/.test(entry),
      )
    )
      return { mode: "invalid" };
    return { mode: "files", paths: new Set(paths) };
  };
  let currentEngineFloor: ResolvedEngineFloor | undefined;
  const checkAction = (node: unknown) => {
    node = resolveNode(node);
    if (!isMap(node)) return;
    inputsOf(node);
    const uses = getNode(node, "uses");
    if (uses === undefined) return;
    const line = nodeLine(uses);
    if (!isScalar(uses) || typeof uses.value !== "string") {
      add({
        rule: "action-pins",
        line,
        message: "action uses must be a string containing a full commit SHA",
      });
      return;
    }
    const value = uses.value;
    if (value.startsWith("$/")) {
      if (
        value.length === 2 ||
        /\s/.test(value) ||
        value.includes("@") ||
        value.includes("${{") ||
        value.includes("\\") ||
        value.split("/").includes("..")
      )
        add({
          rule: "action-pins",
          line,
          message:
            "self-repository actions must use a static repository path without a ref suffix",
        });
      return;
    }
    if (value.startsWith("./")) {
      const selector = staticRepositoryPath(value)
        ? path.posix.normalize(value)
        : undefined;
      const binding =
        selector === undefined
          ? undefined
          : checkoutBindings.findLast(
              (entry) =>
                entry.path === "." ||
                selector === entry.path ||
                selector.startsWith(`${entry.path}/`),
            );
      if (
        selector === undefined ||
        unknownCheckoutDestination ||
        (binding !== undefined && binding.source !== "tracked") ||
        [...checkoutDestinations].some(
          ([prefix, count]) =>
            count > 1 &&
            (prefix === "." ||
              selector === prefix ||
              selector.startsWith(`${prefix}/`)),
        )
      )
        add({
          rule: "action-pins",
          line,
          message:
            "local actions require an unambiguous checkout of the current source snapshot",
        });
      return;
    }
    if (value.startsWith("docker://")) {
      add({
        rule: "action-pins",
        line,
        message: "Docker image actions require a reasoned action-pins opt-out",
      });
      checkRuntimeImage({
        image: value.slice("docker://".length),
        line,
        label: "Docker action image",
      });
      return;
    }
    const remote = /^([^./][^\s@]*\/[^\s@]+)@([^\s]+)$/.exec(value);
    if (remote === null) {
      add({
        rule: "action-pins",
        line,
        message: "remote actions must use a full commit SHA",
      });
      return;
    }
    const action = remote[1]?.toLowerCase();
    const ref = remote[2];
    const approved =
      action === undefined
        ? undefined
        : (approvedActions.get(action) ??
          approvedActions.get(action.split("/").slice(0, 2).join("/")));
    if (ref === undefined || !/^[a-f0-9]{40}$/.test(ref))
      add({
        rule: "action-pins",
        line,
        message: "remote actions must use a full commit SHA",
      });
    else if (approved !== undefined && ref !== approved.sha)
      add({
        rule: "action-pins",
        line,
        message: `${action} must use ${approved.sha}`,
      });
    const declaration = sourceMap({ node, key: "uses" });
    const comment =
      uses.comment ??
      (isMap(declaration) ? declaration.comment : undefined) ??
      "";
    if (
      approved !== undefined &&
      !comment.trim().split(/\s+/).includes(approved.version)
    )
      add({
        rule: "action-pins",
        line,
        message: `${action} requires a # ${approved.version} version comment`,
      });
    if (action === "actions/checkout") {
      const checkoutRepository = getInput(node, "repository");
      const checkoutRef = getInput(node, "ref");
      const prefix = checkoutPrefixOf(node);
      let repo: unknown;
      if (checkoutRepository !== undefined)
        repo = isScalar(checkoutRepository) ? checkoutRepository.value : null;
      const self =
        repo === undefined ||
        repo === "${{ github.repository }}" ||
        (typeof repo === "string" &&
          repository !== undefined &&
          repo.toLowerCase() === repository.toLowerCase());
      const workflowSource =
        repo === "${{ job.workflow_repository }}" &&
        isScalar(checkoutRef) &&
        checkoutRef.value === "${{ job.workflow_sha }}";
      const currentSource = self && checkoutRef === undefined;
      const refValue = isScalar(checkoutRef) ? checkoutRef.value : undefined;
      const dynamicRef = dynamicRefBody(refValue);
      const delegatedSource =
        (self || repo === "${{ job.workflow_repository }}") &&
        dynamicRef !== undefined &&
        dynamicRef !== "" &&
        !/^(?:'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|(?:true|false|null)|-?(?:0x[\da-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?))$/i.test(
          dynamicRef,
        ) &&
        !/^(?:github\s*(?:\.\s*sha|\[\s*['"]sha['"]\s*\])|job\s*(?:\.\s*workflow_sha|\[\s*['"]workflow_sha['"]\s*\]))$/i.test(
          dynamicRef,
        );

      if (!staticRepositoryPath(prefix)) {
        // Unknown checkout destinations may shadow any tracked selector.
        checkoutBindings.push({
          path: ".",
          source: "untrusted",
          reason: "checkout destination must be a static repository path",
          line,
          sparse: { mode: "invalid" },
        });
      } else {
        const destination = normalizeCheckoutPath(prefix);
        const trustedWriter =
          ref === approved?.sha &&
          sourceMap({ node, key: "if" }) === undefined &&
          sourceMap({ node, key: "continue-on-error" }) === undefined &&
          checkoutDestinations.get(destination) === 1 &&
          !unknownCheckoutDestination;
        if (trustedWriter && delegatedSource && typeof refValue === "string")
          checkoutBindings.push({
            path: destination,
            sparse: sparseCheckoutOf(node),
            source: "delegated",
            ref: refValue,
          });
        else if (trustedWriter && (workflowSource || currentSource))
          checkoutBindings.push({
            path: destination,
            sparse: sparseCheckoutOf(node),
            source: "tracked",
          });
        else {
          let reason =
            "checkout does not select a trusted repository source snapshot";
          if (ref !== approved?.sha)
            reason = "actions/checkout must use the approved action SHA";
          else if (
            sourceMap({ node, key: "if" }) !== undefined ||
            sourceMap({ node, key: "continue-on-error" }) !== undefined
          )
            reason =
              "checkout must be unconditional and omit continue-on-error";
          else if (
            checkoutDestinations.get(destination) !== 1 ||
            unknownCheckoutDestination
          )
            reason = "checkout destination must have exactly one static writer";
          checkoutBindings.push({
            path: destination,
            sparse: sparseCheckoutOf(node),
            source: "untrusted",
            reason,
            line,
          });
        }
      }
    }
    let tool: RuntimeDelegation["tool"];
    switch (action) {
      case "actions/setup-node":
        tool = "node";
        break;
      case "actions/setup-python":
        tool = "python";
        break;
      case "oven-sh/setup-bun":
        tool = "bun";
        break;
      default:
        return;
    }
    const literal = getInput(node, `${tool}-version`);
    if (tool === "node" && currentEngineFloor !== undefined) {
      const reference = getInput(node, "node-version-file");
      if (
        reference === undefined &&
        isScalar(literal) &&
        engineFloorSelectorMatches(literal.value, currentEngineFloor)
      ) {
        onEngineFloor?.(currentEngineFloor, "matched");
        return;
      }
      onEngineFloor?.(currentEngineFloor, "mismatch");
      add({
        rule: "runtime-workflow",
        line: nodeLine(literal ?? reference ?? uses),
        message: `engine floor job must select an exact Node patch satisfying ${currentEngineFloor.range} with minimum major ${currentEngineFloor.major}`,
      });
      return;
    }
    if (literal !== undefined)
      add({
        rule: tool === "bun" ? "bun-pins" : "runtime-workflow",
        line: nodeLine(literal),
        message: `setup-${tool} must use ${tool}-version-file`,
      });
    const reference = getInput(node, `${tool}-version-file`);
    checkReference({
      value: isScalar(reference) ? reference.value : undefined,
      tool,
      line: reference === undefined ? line : nodeLine(reference),
    });
  };
  const checkContainer = (node: unknown) => {
    node = resolveNode(node);
    if (node === undefined) return;
    const image = isMap(node) ? getNode(node, "image") : node;
    checkRuntimeImage({
      image: isScalar(image) ? image.value : undefined,
      line: nodeLine(image ?? node),
      label: "container image",
    });
  };
  const checkSteps = (node: unknown, floor?: ResolvedEngineFloor) => {
    currentEngineFloor = undefined;
    checkoutBindings = [];
    checkoutDestinations = new Map();
    unknownCheckoutDestination = false;
    node = resolveNode(node);
    if (!isSeq(node)) return;
    for (const step of node.items) {
      const uses = getNode(step, "uses");
      if (
        !isScalar(uses) ||
        typeof uses.value !== "string" ||
        !uses.value.toLowerCase().startsWith("actions/checkout@")
      )
        continue;
      const prefix = checkoutPrefixOf(step);
      if (!staticRepositoryPath(prefix)) {
        unknownCheckoutDestination = true;
        continue;
      }
      const destination = normalizeCheckoutPath(prefix);
      checkoutDestinations.set(
        destination,
        (checkoutDestinations.get(destination) ?? 0) + 1,
      );
    }
    currentEngineFloor = floor;
    try {
      for (const step of node.items) checkAction(step);
    } finally {
      currentEngineFloor = undefined;
    }
  };
  try {
    // Resolve aliases first with an expansion bound before visiting executable fields.
    document.toJS({ maxAliasCount: 100 });
    if (automationKind === "workflow") {
      const jobs = getNode(document.contents, "jobs");
      if (isMap(jobs))
        for (const key of keysOf(jobs)) {
          checkoutBindings = [];
          checkoutDestinations = new Map();
          unknownCheckoutDestination = false;
          currentEngineFloor = undefined;
          const job = getNode(jobs, key);
          checkAction(job);
          checkContainer(getNode(job, "container"));
          const services = getNode(job, "services");
          if (isMap(services))
            for (const service of keysOf(services))
              checkContainer(getNode(services, service));
          checkSteps(
            getNode(job, "steps"),
            engineFloors.find((entry) => entry.job === key),
          );
        }
    } else {
      const runs = getNode(document.contents, "runs");
      const using = getNode(runs, "using");
      if (isScalar(using) && using.value === "composite")
        checkSteps(getNode(runs, "steps"));
      if (isScalar(using) && using.value === "docker") {
        const image = getNode(runs, "image");
        const value = isScalar(image) ? image.value : undefined;
        if (typeof value === "string" && value.startsWith("docker://")) {
          add({
            rule: "action-pins",
            line: nodeLine(image),
            message:
              "Docker image actions require a reasoned action-pins opt-out",
          });
          checkRuntimeImage({
            image: value.slice("docker://".length),
            line: nodeLine(image),
            label: "Docker action image",
          });
        } else if (
          typeof value !== "string" ||
          value.includes("${{") ||
          value.includes("\\") ||
          value.includes(":") ||
          path.posix.isAbsolute(value) ||
          path.posix
            .normalize(path.posix.join(path.posix.dirname(file), value))
            .split("/")
            .at(0) === ".." ||
          path.posix.basename(value) !== "Dockerfile"
        ) {
          add({
            rule: "action-pins",
            line: nodeLine(image),
            message:
              "Docker actions must reference a local Dockerfile or declare a reasoned action-pins opt-out for an external image",
          });
        }
      }
    }
  } catch {
    add({
      rule: "runtime-workflow",
      line: 1,
      message: "cannot resolve workflow YAML aliases",
    });
  }
  return diagnostics;
};
