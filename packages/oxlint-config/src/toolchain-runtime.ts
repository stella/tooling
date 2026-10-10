import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

import { canonicalDockerRuntime } from "./toolchain-images";
import { githubAutomationFileKind, isMiseConfigPath } from "./toolchain-inputs";

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

type CheckRuntimeFileOptions = {
  file: string;
  text: string;
  policy: RuntimePolicy;
  trackedFiles: ReadonlySet<string>;
  readFile: (file: string) => string | undefined;
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
  };
  const pin = ({
    rule,
    value,
    expected,
    label,
    line = 1,
  }: RuntimePinOptions) => {
    if (
      !(label.includes("python")
        ? pythonSelectorMatches(value, expected)
        : value === expected)
    )
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
      const uv =
        name === "uv.toml" ? parsed : record(tool) ? tool["uv"] : undefined;
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
          label: `.tool-versions ${tool}`,
          line: index + 1,
        });
    });
  }
  if (name.startsWith("Dockerfile") || name === "Containerfile") {
    const variables = new Map<string, string>();
    const escape = /^\s*#\s*escape\s*=\s*([\\`])\s*$/m.exec(text)?.[1] ?? "\\";
    const continuation = new RegExp(`${escape === "`" ? "`" : "\\\\"}\\s*$`);
    const stages = new Set<string>();
    let argumentScope: "global" | "stage" = "global";
    const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
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
        for (const match of content.matchAll(
          /(?:^|\s)<<(-?)(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z_\d]*))/g,
        )) {
          const delimiter = match[2] ?? match[3] ?? match[4];
          if (delimiter !== undefined)
            heredocs.push({ delimiter, stripTabs: match[1] === "-" });
        }
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
      const runtime = /^(node|python|oven\/bun)(?::([^@]+))?(?:@.*)?$/i.exec(
        canonicalDockerRuntime(image),
      );
      if (runtime === null) return;
      const tool = runtime[1]?.toLowerCase();
      const version = runtime[2]?.split("-").at(0);
      const expected =
        tool === "node"
          ? policy.node
          : tool === "python"
            ? policy.python
            : policy.bun;
      pin({
        rule: tool === "oven/bun" ? "bun-pins" : "runtime-docker",
        value: version,
        expected,
        label: `FROM ${tool}`,
        line,
      });
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
  type RuntimeReferenceOptions = {
    value: unknown;
    tool: "node" | "python" | "bun";
    line: number;
  };
  const checkReference = ({ value, tool, line }: RuntimeReferenceOptions) => {
    const allowed =
      tool === "node"
        ? [".node-version", ".nvmrc"]
        : tool === "python"
          ? [".python-version"]
          : ["package.json"];
    const rule = tool === "bun" ? "bun-pins" : "runtime-workflow";
    if (
      typeof value !== "string" ||
      value.includes("${{") ||
      path.posix.isAbsolute(value) ||
      value.split("/").includes("..") ||
      !allowed.includes(path.posix.basename(value)) ||
      !trackedFiles.has(path.posix.normalize(value))
    ) {
      add({
        rule,
        line,
        message: `setup-${tool} must reference a tracked ${allowed.join(" or ")}`,
      });
      return;
    }
    const content = readFile(path.posix.normalize(value));
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
  const checkAction = (node: unknown) => {
    node = resolveNode(node);
    if (!isMap(node)) return;
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
    if (value.startsWith("./")) return;
    if (value.startsWith("docker://")) {
      add({
        rule: "action-pins",
        line,
        message: "Docker image actions require a reasoned action-pins opt-out",
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
    const tool =
      action === "actions/setup-node"
        ? "node"
        : action === "actions/setup-python"
          ? "python"
          : action === "oven-sh/setup-bun"
            ? "bun"
            : undefined;
    if (tool === undefined) return;
    const options = getNode(node, "with");
    const literal = getNode(options, `${tool}-version`);
    if (literal !== undefined)
      add({
        rule: tool === "bun" ? "bun-pins" : "runtime-workflow",
        line: nodeLine(literal),
        message: `setup-${tool} must use ${tool}-version-file`,
      });
    const reference = getNode(options, `${tool}-version-file`);
    checkReference({
      value: isScalar(reference) ? reference.value : undefined,
      tool,
      line: reference === undefined ? line : nodeLine(reference),
    });
  };
  const checkSteps = (node: unknown) => {
    node = resolveNode(node);
    if (isSeq(node)) for (const step of node.items) checkAction(step);
  };
  try {
    // Resolve aliases first with an expansion bound before visiting executable fields.
    document.toJS({ maxAliasCount: 100 });
    if (automationKind === "workflow") {
      const jobs = getNode(document.contents, "jobs");
      if (isMap(jobs))
        for (const key of keysOf(jobs)) {
          const job = getNode(jobs, key);
          checkAction(job);
          checkSteps(getNode(job, "steps"));
        }
    } else {
      const runs = getNode(document.contents, "runs");
      const using = getNode(runs, "using");
      if (isScalar(using) && using.value === "composite")
        checkSteps(getNode(runs, "steps"));
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
