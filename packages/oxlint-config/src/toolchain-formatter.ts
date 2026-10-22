import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";

import {
  githubAutomationFileKind,
  isDockerDefinitionPath,
  isFormatterConfigPath,
  isLefthookConfigPath,
  isShellScript,
} from "./toolchain-inputs";

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

/** Render the shared bunfig.toml [fmt] tables. */
export const sharedFormatTables = (policy: FormatterPolicy) => {
  const scalars = Object.entries(policy.style).filter(
    ([, value]) => !record(value),
  );
  const tables = Object.entries(policy.style).filter(([, value]) =>
    record(value),
  );
  return [
    [
      "[fmt]",
      ...scalars.map(([key, value]) => `${key} = ${tomlValue(value)}`),
      `ignorePatterns = ${tomlValue(policy.ignorePatterns)}`,
    ],
    ...tables.map(([name, table]) => [
      `[fmt.${name}]`,
      ...Object.entries(table as Record<string, unknown>).map(
        ([key, value]) => `${key} = ${tomlValue(value)}`,
      ),
    ]),
  ]
    .map((lines) => `${lines.join("\n")}\n`)
    .join("\n");
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
      .split(/\r?\n|&&|\|\||;/u)
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

const checkFormatConfig = (
  bunfig: string,
  policy: FormatterPolicy,
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
  for (const [key, value] of Object.entries(policy.style))
    if (stableJson(fmt[key]) !== stableJson(value))
      errors.push(
        `bunfig.toml [fmt] ${key} must equal the shared style:\n${sharedFormatTables(policy)}`,
      );
  return errors;
};

type CheckFormatterOptions = {
  files: Record<string, string>;
  policy: FormatterPolicy;
  usesBun: boolean;
};

/** bun fmt is the only formatter: one config table, staged hooks and a full CI check. */
export const checkFormatter = ({
  files,
  policy,
  usesBun,
}: CheckFormatterOptions): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const add = (file: string, line: number, message: string) =>
    diagnostics.push({ rule: formatterRule, path: file, line, message });
  const workflowCommands: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    const name = path.posix.basename(file);
    if (isFormatterConfigPath(file))
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
        if (
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
    for (const message of checkFormatConfig(bunfig, policy))
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
  return diagnostics;
};
