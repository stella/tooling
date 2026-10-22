import { expect, test } from "bun:test";

import toolchain from "../toolchain.json";
import {
  checkFormatter,
  parseFormatterPolicy,
  sharedFormatTables,
} from "./toolchain-formatter";
import { toolchainInputKind } from "./toolchain-inputs";

const policy = parseFormatterPolicy(toolchain.formatter);

const bunfig = `[install]
minimumReleaseAge = 432000

[fmt]
printWidth = 80
ignorePatterns = ["dist/"]

[fmt.sortImports]
customGroups = [
  { groupName = "react", elementNamePattern = ["react"] },
  { groupName = "stella", elementNamePattern = ["@stll/**"] },
]
groups = ["react", ["builtin", "external"], "stella", ["parent", "sibling"]]
newlinesBetween = true
`;

const workflow = `on: pull_request
jobs:
  check:
    runs-on: ubuntu-24.04
    steps:
      - run: bun install --frozen-lockfile
      - name: Format
        run: bun fmt --check
`;

const lefthook = `pre-commit:
  commands:
    format:
      run: bun fmt --staged
`;

const repository: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      private: true,
      packageManager: `bun@${toolchain.bun}`,
      scripts: { lint: "oxlint ." },
      devDependencies: { oxlint: toolchain.oxlint },
    },
    null,
    2,
  ),
  "bunfig.toml": bunfig,
  ".github/workflows/ci.yml": workflow,
  "lefthook.yml": lefthook,
};

const check = (
  files: Record<string, string | undefined>,
  usesBun = true,
) =>
  checkFormatter({
    files: Object.fromEntries(
      Object.entries({ ...repository, ...files }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    policy,
    usesBun,
  }).map(({ path, message }) => `${path}: ${message}`);

const manifest = (fields: Record<string, unknown>) =>
  JSON.stringify(
    { private: true, packageManager: `bun@${toolchain.bun}`, ...fields },
    null,
    2,
  );

test("a repository formatted only by bun fmt passes", () => {
  expect(check({})).toEqual([]);
});

test("the shared policy is closed and names bun fmt", () => {
  expect(() =>
    parseFormatterPolicy({ ...toolchain.formatter, command: "oxfmt" }),
  ).toThrow("bun fmt");
  expect(() =>
    parseFormatterPolicy({ ...toolchain.formatter, semi: false }),
  ).toThrow("accepts only");
  expect(() =>
    parseFormatterPolicy({ ...toolchain.formatter, printWidth: 0 }),
  ).toThrow("printWidth");
});

test("every alternative formatter dependency fails, wherever it is declared", () => {
  for (const fields of [
    { devDependencies: { oxfmt: "0.72.0" } },
    { dependencies: { prettier: "3.9.10" } },
    { optionalDependencies: { "@biomejs/biome": "2.0.0" } },
    { peerDependencies: { dprint: "0.50.0" } },
    { devDependencies: { "@dprint/typescript": "0.95.0" } },
    { devDependencies: { "prettier-plugin-tailwindcss": "0.7.0" } },
    { devDependencies: { "@trivago/prettier-plugin-sort-imports": "6.0.0" } },
    { catalog: { oxfmt: "0.72.0" } },
    { catalogs: { tools: { oxfmt: "0.72.0" } } },
    { workspaces: { packages: ["a"], catalog: { prettier: "3.9.10" } } },
    { overrides: { prettier: "3.9.10" } },
  ]) {
    const result = check({ "packages/a/package.json": manifest(fields) });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("bun fmt is the only formatter");
  }
});

test("formatter configuration files and package.json prettier keys fail", () => {
  for (const file of [
    ".oxfmtrc.json",
    ".oxfmtrc.jsonc",
    "oxfmt.config.ts",
    ".prettierrc",
    ".prettierrc.json",
    "prettier.config.mjs",
    ".prettierignore",
    "biome.json",
    "dprint.json",
    "apps/web/.oxfmtrc.json",
  ]) {
    expect(toolchainInputKind(file)).toBe("presence");
    expect(check({ [file]: "" })).toEqual([
      `${file}: formatter configuration belongs in bunfig.toml [fmt]; remove this file`,
    ]);
  }
  expect(
    check({ "package.json": manifest({ prettier: { semi: false } }) }),
  ).toEqual([
    "package.json: package.json prettier configuration belongs in bunfig.toml [fmt]",
  ]);
});

test("commands that run another formatter fail in scripts, workflows, hooks, images and shells", () => {
  for (const command of [
    "oxfmt .",
    "bun --bun oxfmt -c .oxfmtrc.json",
    "bunx prettier --write .",
    "node_modules/.bin/prettier --check src",
    "biome format --write .",
    "npx dprint fmt",
  ]) {
    expect(
      check({ "package.json": manifest({ scripts: { format: command } }) }),
    ).toEqual([
      "package.json: script format runs another formatter; use bun fmt",
    ]);
    expect(
      check({
        ".github/workflows/ci.yml": `${workflow}      - run: ${command}\n`,
      }),
    ).toEqual([
      ".github/workflows/ci.yml: command runs another formatter; use bun fmt",
    ]);
    expect(
      check({ "scripts/format.sh": `#!/bin/sh\n# ${command}\n${command}\n` }),
    ).toEqual([
      "scripts/format.sh: command runs another formatter; use bun fmt",
    ]);
    expect(
      check({ Dockerfile: `FROM scratch\nRUN ${command}\n` }),
    ).toEqual(["Dockerfile: command runs another formatter; use bun fmt"]);
  }
  // Mentioning a formatter is not running it.
  expect(
    check({
      "package.json": manifest({ scripts: { docs: "echo prettier-free" } }),
    }),
  ).toEqual([]);
  expect(check({ "package.json": manifest({ scripts: { lint: "biome lint ." } }) })).toEqual([]);
});

test("a package script named fmt would shadow bun fmt", () => {
  expect(
    check({
      "packages/a/package.json": manifest({ scripts: { fmt: "bun fmt" } }),
    }),
  ).toEqual(["packages/a/package.json: a package script named fmt shadows bun fmt; remove it"]);
});

test("changesets must not run a formatter", () => {
  expect(toolchainInputKind(".changeset/config.json")).toBe("config");
  expect(check({ ".changeset/config.json": '{"format": false}' })).toEqual([]);
  for (const format of ['"oxfmt"', '"prettier"', '"auto"'])
    expect(
      check({ ".changeset/config.json": `{"format": ${format}}` }),
    ).toEqual([
      ".changeset/config.json: changesets must not run a formatter (format: false); format releases with bun fmt",
    ]);
  expect(check({ ".changeset/config.json": "{}" })).toHaveLength(1);
});

test("bunfig.toml [fmt] carries the shared style", () => {
  const shared = (replacement: [string, string]) =>
    check({ "bunfig.toml": bunfig.replace(...replacement) });
  expect(shared(["[fmt]\n", "[format]\n"])).toEqual([
    `bunfig.toml: bunfig.toml requires a [fmt] table: bun fmt reads its configuration only from there; start from:\n${sharedFormatTables(policy)}`,
  ]);
  expect(
    check({ "bunfig.toml": `[install]\n\n${sharedFormatTables(policy)}` }),
  ).toEqual([]);
  expect(shared(["printWidth = 80", "printWidth = 100"])).toEqual([
    "bunfig.toml: bunfig.toml [fmt] printWidth must equal the shared 80",
  ]);
  expect(shared(["newlinesBetween = true", "newlinesBetween = false"])).toEqual(
    [
      "bunfig.toml: bunfig.toml [fmt.sortImports] newlinesBetween must equal the shared true",
    ],
  );
  expect(shared(['["@stll/**"]', '["@stll/*"]'])).toEqual([
    "bunfig.toml: bunfig.toml [fmt.sortImports] customGroups must include the shared stella group (@stll/**)",
  ]);
  expect(shared(['"stella", ["parent"', '["parent"'])).toEqual([
    "bunfig.toml: bunfig.toml [fmt.sortImports] groups must place the shared stella group",
  ]);
  expect(
    check({
      "bunfig.toml": "[install]\n\n[fmt]\nprintWidth = 80\n",
    }),
  ).toEqual([
    "bunfig.toml: bunfig.toml requires a [fmt.sortImports] table with the shared import groups",
  ]);
});

test("hooks format staged files and CI checks the whole repository", () => {
  expect(toolchainInputKind("lefthook.yml")).toBe("config");
  for (const hook of [
    "pre-commit:\n  commands:\n    format:\n      run: bun fmt --staged {staged_files}\n",
    "pre-commit:\n  commands:\n    format:\n      run: bun fmt\n",
    "pre-push:\n  commands:\n    format:\n      run: bun fmt --staged\n",
  ])
    expect(check({ "lefthook.yml": hook })).toEqual([
      "lefthook.yml: lefthook pre-commit must run bun fmt --staged",
    ]);
  expect(
    check({
      "lefthook.yml":
        "pre-commit:\n  jobs:\n    - run: bun run guard && bun fmt --staged\n",
    }),
  ).toEqual([]);
  for (const step of ["bun fmt --check src", "bun fmt", "bun run format"])
    expect(
      check({
        ".github/workflows/ci.yml": workflow.replace("bun fmt --check", step),
      }),
    ).toEqual([
      ".github/workflows: a workflow must run bun fmt --check over the whole repository",
    ]);
  expect(
    check({
      ".github/workflows/ci.yml": workflow.replace(
        "bun fmt --check",
        "bun install && bun fmt --check --log-level=warn",
      ),
    }),
  ).toEqual([]);
});

test("repositories without Bun only get the formatter bans", () => {
  expect(
    check(
      {
        "bunfig.toml": undefined,
        "lefthook.yml": "pre-commit:\n  commands: {}\n",
        ".github/workflows/ci.yml": "on: push\njobs: {}\n",
      },
      false,
    ),
  ).toEqual([]);
  expect(check({ ".prettierrc": "" }, false)).toHaveLength(1);
});
