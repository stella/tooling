import path from "node:path";
import picomatch from "picomatch";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";

import {
  githubAutomationFileKind,
  isDockerDefinitionPath,
  isFormatterConfigPath,
  isLefthookConfigPath,
  isShellScript,
} from "./toolchain-inputs";
import { decodeShellWord, shellCommandSegments } from "./toolchain-packages";
import { workspaceContains } from "./toolchain-workspaces";

export const formatterRule = "formatter-policy" as const;

type Diagnostic = {
  rule: typeof formatterRule;
  path: string;
  line: number;
  message: string;
};

export type FormatterStyle = Readonly<Record<string, unknown>>;

export type FormatterPolicy = {
  command: "bun fmt";
  style: FormatterStyle;
  /** Generated files every repository leaves to their generators. */
  ignorePatterns: readonly string[];
};

/** Repository-owned [fmt] keys: what to skip, and the Tailwind entry point. */
export const repositoryFormatKeys = [
  "ignorePatterns",
  "sortTailwindcss",
] as const;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One style for every repository; only repository-owned keys may differ. */
export const parseFormatterPolicy = (input: unknown): FormatterPolicy => {
  if (
    !record(input) ||
    Object.keys(input).some(
      (key) => key !== "command" && key !== "style" && key !== "ignorePatterns",
    )
  )
    throw new Error(
      "toolchain.json formatter accepts only command, style and ignorePatterns",
    );
  if (input["command"] !== "bun fmt")
    throw new Error("toolchain.json formatter command must be bun fmt");
  const style = input["style"];
  if (!record(style) || Object.keys(style).length === 0)
    throw new Error("toolchain.json formatter style must be a nonempty table");
  for (const key of Object.keys(style))
    if (repositoryFormatKeys.some((owned) => owned === key))
      throw new Error(
        `toolchain.json formatter style cannot own the repository key ${key}`,
      );
  const ignorePatterns = input["ignorePatterns"];
  if (
    !Array.isArray(ignorePatterns) ||
    !ignorePatterns.every(
      (pattern): pattern is string =>
        typeof pattern === "string" && pattern !== "",
    )
  )
    throw new Error(
      "toolchain.json formatter ignorePatterns must be nonempty strings",
    );
  return { command: "bun fmt", style, ignorePatterns };
};

const tomlValue = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (record(value))
    return `{ ${Object.entries(value)
      .map(([key, entry]) => `${key} = ${tomlValue(entry)}`)
      .join(", ")} }`;
  return JSON.stringify(value);
};

const tomlLines = (entries: readonly (readonly [string, unknown])[]) =>
  entries.map(([key, value]) => `${key} = ${tomlValue(value)}\n`).join("");

/** Render the shared bunfig.toml [fmt] tables. */
export const sharedFormatTables = (policy: FormatterPolicy) => {
  const entries = Object.entries(policy.style);
  let output = `[fmt]\n${tomlLines(
    entries.filter(([, value]) => !record(value)),
  )}ignorePatterns = ${tomlValue(policy.ignorePatterns)}\n`;
  for (const [name, table] of entries)
    if (record(table))
      output += `\n[fmt.${name}]\n${tomlLines(Object.entries(table))}`;
  return output;
};

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    record(entry)
      ? Object.fromEntries(
          Object.entries(entry).toSorted(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : entry,
  );

// Every alternative formatter is rejected, not only the one being replaced.
const formatterPackage = (name: string) =>
  name === "oxfmt" ||
  name === "prettier" ||
  name === "dprint" ||
  name === "@biomejs/biome" ||
  name.startsWith("@dprint/") ||
  /^(?:@[^/]+\/)?prettier-plugin-/.test(name);

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "resolutions",
  "catalog",
] as const;

const declaredPackages = (manifest: Record<string, unknown>) => {
  const tables: unknown[] = dependencyFields.map((field) => manifest[field]);
  const workspaces = manifest["workspaces"];
  for (const owner of [manifest, record(workspaces) ? workspaces : {}]) {
    if (owner !== manifest) tables.push(owner["catalog"]);
    const catalogs = owner["catalogs"];
    if (record(catalogs)) tables.push(...Object.values(catalogs));
  }
  return tables.flatMap((table) => (record(table) ? Object.keys(table) : []));
};

const shellWords = (command: string) =>
  command
    .split(/[\s;&|()<>`]+/u)
    .map((word) => word.replace(/^["']+|["']+$/gu, ""))
    .filter((word) => word !== "");

/** Over-approximate: any formatter executable named as a word is an invocation. */
const invokesFormatter = (command: string) => {
  const words = shellWords(command);
  return words.some((word, index) => {
    const name = path.posix.basename(word);
    if (name === "oxfmt" || name === "prettier" || name === "dprint")
      return true;
    return (
      name === "biome" &&
      ["format", "check", "ci"].includes(words.at(index + 1) ?? "")
    );
  });
};

const lineOf = (text: string, needle: string) =>
  Math.max(
    1,
    text.split(/\r?\n/u).findIndex((line) => line.includes(needle)) + 1,
  );

/** Collect every `run` string of a workflow, composite action or hook config. */
const runValues = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(runValues);
  if (!record(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    key === "run" && typeof entry === "string" ? [entry] : runValues(entry),
  );
};

const commandLines = (commands: readonly string[]) =>
  commands.flatMap((command) =>
    command
      .replace(/\\\r?\n/gu, " ")
      .split(/\r?\n|&&|;/u)
      .map((line) => line.trim()),
  );

const isBunFormat = (line: string, flag: "--check" | "--staged") => {
  const words = shellWords(line);
  // Only flags may follow: a path operand narrows the check below the repository.
  return (
    words[0] === "bun" &&
    words[1] === "fmt" &&
    words.slice(2).includes(flag) &&
    words.slice(2).every((word) => word.startsWith("-"))
  );
};

/** Package directories that the root workspaces patterns select. */
const workspacePackageRoots = (files: Record<string, string>) => {
  let manifest: unknown;
  try {
    manifest = JSON.parse(files["package.json"] ?? "");
  } catch {
    return [];
  }
  if (!record(manifest)) return [];
  const declared = manifest["workspaces"];
  // Bun accepts the array form and the { packages } object form.
  const patterns = record(declared) ? declared["packages"] : declared;
  return Object.keys(files)
    .filter(
      (file) =>
        file.endsWith("/package.json") &&
        workspaceContains({
          directory: ".",
          file,
          patterns,
          rootMembership: "patterns",
        }),
    )
    .map((file) => path.posix.dirname(file));
};

// Representative package files: the manifest and common source layouts and
// extensions. An ignore that matches any of them drops package sources.
const packageSourceProbes = [
  "package.json",
  "index.ts",
  "index.js",
  "src/index.ts",
  "src/index.tsx",
  "src/index.js",
  "src/index.mjs",
  "src/main.ts",
  "src/nested/module.ts",
  "src/nested/component.tsx",
  "lib/index.ts",
  "lib/index.js",
] as const;

/**
 * Ignore-file matching at one path level: a trailing slash limits a pattern to
 * directories, and a leading or inner slash anchors it at the root; otherwise
 * it matches at any depth.
 */
const matchesLevel = (pattern: string, level: string, directory: boolean) => {
  if (pattern.endsWith("/") && !directory) return false;
  const anchored = pattern.replace(/\/+$/u, "").includes("/");
  const body = pattern.replace(/^\/+|\/+$/gu, "");
  // An empty pattern ("/") matches nothing.
  if (body === "") return false;
  const globs = anchored ? [body] : [body, `**/${body}`];
  return globs.some((glob) => picomatch.isMatch(level, glob, { dot: true }));
};

/** The patterns that match a path or one of its directories. */
const ignoringPatterns = (patterns: readonly string[], file: string) => {
  const parts = file.split("/");
  return patterns.filter((pattern) =>
    parts.some((_, index) =>
      matchesLevel(
        pattern,
        parts.slice(0, index + 1).join("/"),
        index < parts.length - 1,
      ),
    ),
  );
};

const checkFormatConfig = (
  bunfig: string,
  policy: FormatterPolicy,
  packageRoots: readonly string[],
): string[] => {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(bunfig);
  } catch {
    return ["bunfig.toml must be valid TOML"];
  }
  const fmt = parsed["fmt"];
  if (!record(fmt))
    return [
      `bunfig.toml requires a [fmt] table: bun fmt reads its configuration only from there; start from:\n${sharedFormatTables(policy)}`,
    ];
  const errors: string[] = [];
  for (const key of Object.keys(fmt))
    if (
      !Object.hasOwn(policy.style, key) &&
      !repositoryFormatKeys.some((owned) => owned === key)
    )
      errors.push(
        `bunfig.toml [fmt] ${key} is not part of the shared style; every repository formats alike`,
      );
  const ignored = Array.isArray(fmt["ignorePatterns"])
    ? fmt["ignorePatterns"]
    : [];
  const missing = policy.ignorePatterns.filter(
    (pattern) => !ignored.includes(pattern),
  );
  if (missing.length > 0)
    errors.push(
      `bunfig.toml [fmt] ignorePatterns must include the shared generated files: ${missing.join(", ")}`,
    );
  // Ignores are for generated or vendored paths; one that covers a workspace
  // package silently drops its sources from bun fmt --check. Negations are not
  // accepted, so every listed pattern only ever removes files.
  const patterns = ignored.filter(
    (pattern): pattern is string => typeof pattern === "string",
  );
  for (const pattern of patterns)
    if (pattern.startsWith("!"))
      errors.push(
        `bunfig.toml [fmt] ignorePatterns entry ${pattern} re-includes files; list only generated or vendored paths`,
      );
  const positives = patterns.filter((pattern) => !pattern.startsWith("!"));
  const covered = new Map<string, string[]>();
  for (const root of packageRoots)
    for (const probe of packageSourceProbes) {
      for (const pattern of ignoringPatterns(positives, `${root}/${probe}`)) {
        if (policy.ignorePatterns.includes(pattern)) continue;
        const roots = covered.get(pattern) ?? [];
        if (!roots.includes(root)) roots.push(root);
        covered.set(pattern, roots);
      }
    }
  for (const pattern of patterns) {
    const roots = covered.get(pattern);
    if (roots !== undefined)
      errors.push(
        `bunfig.toml [fmt] ignorePatterns entry ${pattern} covers workspace packages (${roots.join(", ")}); ignore only their generated or vendored paths`,
      );
  }
  for (const [key, value] of Object.entries(policy.style))
    if (stableJson(fmt[key]) !== stableJson(value))
      errors.push(
        `bunfig.toml [fmt] ${key} must equal the shared style:\n${sharedFormatTables(policy)}`,
      );
  return errors;
};

export const parseFormatterStagedSelector = (input: unknown) => {
  if (input === undefined) return undefined;
  if (
    !record(input) ||
    Object.keys(input).some((key) => key !== "script" && key !== "reason") ||
    typeof input["script"] !== "string" ||
    typeof input["reason"] !== "string" ||
    input["reason"].trim() === "" ||
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:ts|mts|js|mjs)$/.test(
      input["script"],
    ) ||
    input["script"].split("/").some((part) => part === "." || part === "..")
  )
    throw new Error(
      "formatterStagedSelector requires a normalized script path and nonempty reason",
    );
  return { script: input["script"], reason: input["reason"] };
};

const hasDeclaredStagedCommand = (input: unknown, script: string): boolean => {
  if (Array.isArray(input))
    return input.some((value) => hasDeclaredStagedCommand(value, script));
  if (!record(input)) return false;
  if (
    input["files"] === `bun ${script}` &&
    typeof input["run"] === "string" &&
    !["glob", "exclude", "skip", "root"].some((key) => input[key] !== undefined)
  ) {
    const words = shellWords(input["run"]);
    if (
      words[0] === "bun" &&
      words[1] === "fmt" &&
      words.at(-1) === "{files}" &&
      words.slice(2, -1).includes("--staged") &&
      words
        .slice(2, -1)
        .every((word) => word === "--staged" || word === "--ignore-unknown")
    )
      return true;
  }
  return Object.values(input).some((value) =>
    hasDeclaredStagedCommand(value, script),
  );
};

export const parseFormatterCheckSource = (input: unknown) => {
  if (input === undefined) return undefined;
  const keys = ["source", "workflow", "job", "runner", "argument", "reason"];
  if (
    !record(input) ||
    Object.keys(input).some((key) => !keys.includes(key)) ||
    keys.some(
      (key) => typeof input[key] !== "string" || input[key].trim() === "",
    )
  )
    throw new Error(
      "formatterCheckSource requires source, workflow, job, runner, argument and reason strings",
    );
  const { source, workflow, job, runner, argument, reason } = input;
  if (
    typeof source !== "string" ||
    typeof workflow !== "string" ||
    typeof job !== "string" ||
    typeof runner !== "string" ||
    typeof argument !== "string" ||
    typeof reason !== "string"
  )
    throw new Error("Invalid formatter check source");
  if (
    ![source, runner].every(
      (value) =>
        /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) &&
        !value.split("/").some((part) => part === "." || part === ".."),
    ) ||
    !/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(workflow) ||
    !/\.ya?ml$/.test(source) ||
    !/\.(?:ts|mts|js|mjs)$/.test(runner) ||
    !/^[A-Za-z0-9_:-]+$/.test(argument)
  )
    throw new Error(
      "formatterCheckSource requires normalized tracked YAML/source paths and a literal runner argument",
    );
  return { source, workflow, job, runner, argument, reason };
};

const declaredCheckCommands = (
  files: Record<string, string>,
  declaration: NonNullable<ReturnType<typeof parseFormatterCheckSource>>,
) => {
  if (
    [declaration.source, declaration.workflow, declaration.runner].some(
      (file) => files[file] === undefined,
    )
  )
    return [];
  try {
    const workflow = parseDocument(files[declaration.workflow] ?? "");
    const source = parseDocument(files[declaration.source] ?? "");
    if (workflow.errors.length > 0 || source.errors.length > 0) return [];
    const value: unknown = workflow.toJS();
    if (!record(value) || !record(value["jobs"])) return [];
    const job = value["jobs"][declaration.job];
    const rootDirectory = (entry: unknown) =>
      !record(entry) ||
      entry["working-directory"] === undefined ||
      entry["working-directory"] === ".";
    const defaultRoot = (entry: unknown) =>
      !record(entry) ||
      !record(entry["defaults"]) ||
      rootDirectory(entry["defaults"]["run"]);
    if (
      !record(job) ||
      !Array.isArray(job["steps"]) ||
      !defaultRoot(value) ||
      !defaultRoot(job)
    )
      return [];
    const commands = job["steps"].flatMap((step) =>
      record(step) && typeof step["run"] === "string" && rootDirectory(step)
        ? [step["run"]]
        : [],
    );
    const invoked = commands.some((command) =>
      shellCommandSegments(command).some((raw) => {
        const words = raw.map(decodeShellWord);
        while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words.at(0) ?? ""))
          words.shift();
        if (words.at(0) === "exec") words.shift();
        return (
          JSON.stringify(words) ===
          JSON.stringify([
            "bun",
            declaration.runner,
            "run",
            declaration.argument,
          ])
        );
      }),
    );
    const checks: unknown = source.toJS();
    if (!invoked || !record(checks) || !Array.isArray(checks["checks"]))
      return [];
    return checks["checks"].flatMap((check) =>
      record(check) && typeof check["run"] === "string" && rootDirectory(check)
        ? [check["run"]]
        : [],
    );
  } catch {
    return [];
  }
};

type CheckFormatterOptions = {
  files: Record<string, string>;
  policy: FormatterPolicy;
  usesBun: boolean;
  stagedSelector?: ReturnType<typeof parseFormatterStagedSelector>;
  checkSource?: ReturnType<typeof parseFormatterCheckSource>;
};

// Bun's formatter searches ancestor Prettier configuration even across checkout
// boundaries. An empty root mapping stops that search without owning any style.
const isFormatterBoundary = (file: string, text: string) => {
  if (file !== ".prettierrc.yml") return false;
  const document = parseDocument(text);
  if (document.errors.length > 0) return false;
  try {
    const value: unknown = document.toJS();
    return record(value) && Object.keys(value).length === 0;
  } catch {
    return false;
  }
};

/** bun fmt is the only formatter: one config table, staged hooks and a full CI check. */
export const checkFormatter = ({
  files,
  policy,
  usesBun,
  stagedSelector,
  checkSource,
}: CheckFormatterOptions): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const add = (file: string, line: number, message: string) =>
    diagnostics.push({ rule: formatterRule, path: file, line, message });
  const workflowCommands: string[] = [];
  if (checkSource !== undefined) {
    const commands = declaredCheckCommands(files, checkSource);
    if (!commandLines(commands).some((line) => isBunFormat(line, "--check")))
      add(
        "stll-toolchain.json",
        1,
        "formatterCheckSource requires tracked regular source and runner files, an exact workflow job invocation, and a whole-repository bun fmt --check command",
      );
    else workflowCommands.push(...commands);
  }
  let stagedSelectorUsed = false;
  for (const [file, text] of Object.entries(files)) {
    const name = path.posix.basename(file);
    if (isFormatterConfigPath(file) && !isFormatterBoundary(file, text))
      add(
        file,
        1,
        "formatter configuration belongs in bunfig.toml [fmt]; remove this file",
      );
    if (name === "package.json") {
      let manifest: unknown;
      try {
        manifest = JSON.parse(text);
      } catch {
        // Package diagnostics already reject malformed manifests.
        continue;
      }
      if (!record(manifest)) continue;
      for (const dependency of declaredPackages(manifest))
        if (formatterPackage(dependency))
          add(
            file,
            lineOf(text, JSON.stringify(dependency)),
            `${dependency} is not allowed: bun fmt is the only formatter`,
          );
      if (manifest["prettier"] !== undefined)
        add(
          file,
          lineOf(text, '"prettier"'),
          "package.json prettier configuration belongs in bunfig.toml [fmt]",
        );
      const scripts = manifest["scripts"];
      if (record(scripts))
        for (const [script, command] of Object.entries(scripts)) {
          if (script === "fmt")
            add(
              file,
              lineOf(text, '"fmt"'),
              "a package script named fmt shadows bun fmt; remove it",
            );
          if (typeof command === "string" && invokesFormatter(command))
            add(
              file,
              lineOf(text, JSON.stringify(script)),
              `script ${script} runs another formatter; use bun fmt`,
            );
        }
      continue;
    }
    if (file === ".changeset/config.json") {
      try {
        const config: unknown = JSON.parse(text);
        if (record(config) && config["format"] !== false)
          add(
            file,
            lineOf(text, '"format"'),
            "changesets must not run a formatter (format: false); format releases with bun fmt",
          );
      } catch {
        add(file, 1, "changeset configuration must be valid JSON");
      }
      continue;
    }
    const automation = githubAutomationFileKind(file);
    if (automation !== undefined || isLefthookConfigPath(file)) {
      const document = parseDocument(text);
      if (document.errors.length > 0) continue;
      const parsed: unknown = document.toJS();
      const commands = runValues(parsed);
      for (const command of commands)
        if (invokesFormatter(command))
          add(
            file,
            lineOf(text, command.split(/\r?\n/u)[0] ?? command),
            "command runs another formatter; use bun fmt",
          );
      if (automation === "workflow") workflowCommands.push(...commands);
      if (isLefthookConfigPath(file) && usesBun) {
        const preCommit = record(parsed) ? parsed["pre-commit"] : undefined;
        const declared =
          stagedSelector !== undefined &&
          files[stagedSelector.script] !== undefined &&
          hasDeclaredStagedCommand(preCommit, stagedSelector.script);
        stagedSelectorUsed ||= declared;
        if (
          !declared &&
          !commandLines(runValues(preCommit)).some((line) =>
            isBunFormat(line, "--staged"),
          )
        )
          add(
            file,
            lineOf(text, "pre-commit"),
            "lefthook pre-commit must run bun fmt --staged",
          );
      }
      continue;
    }
    if (
      text !== "" &&
      (isDockerDefinitionPath(file) || isShellScript(file, text))
    )
      for (const [index, line] of text.split(/\r?\n/u).entries())
        if (!line.trimStart().startsWith("#") && invokesFormatter(line))
          add(file, index + 1, "command runs another formatter; use bun fmt");
  }
  if (!usesBun) return diagnostics;
  const bunfig = files["bunfig.toml"];
  if (bunfig !== undefined)
    for (const message of checkFormatConfig(
      bunfig,
      policy,
      workspacePackageRoots(files),
    ))
      add("bunfig.toml", lineOf(bunfig, "[fmt"), message);
  const hasWorkflows = Object.keys(files).some(
    (file) => githubAutomationFileKind(file) === "workflow",
  );
  if (
    hasWorkflows &&
    !commandLines(workflowCommands).some((line) => isBunFormat(line, "--check"))
  )
    add(
      ".github/workflows",
      1,
      "a workflow must run bun fmt --check over the whole repository",
    );
  if (stagedSelector !== undefined && !stagedSelectorUsed)
    add(
      "stll-toolchain.json",
      1,
      "formatterStagedSelector must name a tracked regular script used by an exact pre-commit bun fmt --staged {files} command without additional path filters",
    );
  return diagnostics;
};
