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

type ImportGroup = { groupName: string; elementNamePattern: string[] };

export type FormatterPolicy = {
  command: "bun fmt";
  sortImports: {
    newlinesBetween: boolean;
    customGroups: ImportGroup[];
  };
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((entry) => typeof entry === "string" && entry !== "");

const importGroup = (value: unknown): value is ImportGroup =>
  record(value) &&
  typeof value["groupName"] === "string" &&
  value["groupName"] !== "" &&
  strings(value["elementNamePattern"]);

/** The shared style is closed: every consumer must carry each key verbatim. */
export const parseFormatterPolicy = (input: unknown): FormatterPolicy => {
  if (
    !record(input) ||
    Object.keys(input).some((key) => key !== "command" && key !== "sortImports")
  )
    throw new Error(
      "toolchain.json formatter accepts only command and sortImports",
    );
  if (input["command"] !== "bun fmt")
    throw new Error("toolchain.json formatter command must be bun fmt");
  const sortImports = input["sortImports"];
  if (
    !record(sortImports) ||
    typeof sortImports["newlinesBetween"] !== "boolean" ||
    !Array.isArray(sortImports["customGroups"]) ||
    !sortImports["customGroups"].every(importGroup)
  )
    throw new Error(
      "toolchain.json formatter sortImports requires newlinesBetween and customGroups",
    );
  return {
    command: "bun fmt",
    sortImports: {
      newlinesBetween: sortImports["newlinesBetween"],
      customGroups: sortImports["customGroups"],
    },
  };
};

/** Render the smallest bunfig.toml [fmt] tables that satisfy the shared style. */
export const sharedFormatTables = (policy: FormatterPolicy) => {
  const { customGroups, newlinesBetween } = policy.sortImports;
  const groups = customGroups
    .map(
      ({ groupName, elementNamePattern }) =>
        `{ groupName = ${JSON.stringify(groupName)}, elementNamePattern = ${JSON.stringify(elementNamePattern)} }`,
    )
    .join(", ");
  const order = [
    "builtin",
    "external",
    ...customGroups.map((group) => group.groupName),
    "parent",
    "sibling",
    "index",
  ];
  return `[fmt]\n\n[fmt.sortImports]\ncustomGroups = [${groups}]\ngroups = ${JSON.stringify(order)}\nnewlinesBetween = ${String(newlinesBetween)}\n`;
};

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

const sameGroup = (left: ImportGroup, right: unknown) =>
  importGroup(right) &&
  left.groupName === right.groupName &&
  left.elementNamePattern.length === right.elementNamePattern.length &&
  left.elementNamePattern.every((pattern) =>
    right.elementNamePattern.includes(pattern),
  );

const groupNames = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((entry) =>
        typeof entry === "string" ? [entry] : groupNames(entry),
      )
    : [];

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
  const sortImports = fmt["sortImports"];
  if (!record(sortImports))
    return [
      ...errors,
      "bunfig.toml requires a [fmt.sortImports] table with the shared import groups",
    ];
  if (sortImports["newlinesBetween"] !== policy.sortImports.newlinesBetween)
    errors.push(
      `bunfig.toml [fmt.sortImports] newlinesBetween must equal the shared ${String(policy.sortImports.newlinesBetween)}`,
    );
  const customGroups = Array.isArray(sortImports["customGroups"])
    ? sortImports["customGroups"]
    : [];
  const ordered = groupNames(sortImports["groups"]);
  for (const group of policy.sortImports.customGroups) {
    if (!customGroups.some((candidate) => sameGroup(group, candidate)))
      errors.push(
        `bunfig.toml [fmt.sortImports] customGroups must include the shared ${group.groupName} group (${group.elementNamePattern.join(", ")})`,
      );
    if (!ordered.includes(group.groupName))
      errors.push(
        `bunfig.toml [fmt.sortImports] groups must place the shared ${group.groupName} group`,
      );
  }
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
