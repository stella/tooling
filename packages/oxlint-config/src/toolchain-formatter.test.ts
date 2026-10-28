import { expect, test } from "bun:test";

import toolchain from "../toolchain.json";
import {
  checkFormatter,
  parseFormatterCheckSource,
  parseFormatterPolicy,
  parseFormatterStagedSelector,
  sharedFormatTables,
} from "./toolchain-formatter";
import { toolchainInputKind } from "./toolchain-inputs";

const policy = parseFormatterPolicy(toolchain.formatter);

const sharedTables = sharedFormatTables(policy);
const bunfig = `[install]
minimumReleaseAge = 432000

${sharedTables.replace("ignorePatterns = [", 'ignorePatterns = ["dist/", ')}`;

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

const check = (files: Record<string, string | undefined>, usesBun = true) =>
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
    parseFormatterPolicy({
      ...toolchain.formatter,
      style: { ...toolchain.formatter.style, ignorePatterns: [] },
    }),
  ).toThrow("repository key ignorePatterns");
  expect(() =>
    parseFormatterPolicy({ ...toolchain.formatter, ignorePatterns: [""] }),
  ).toThrow("ignorePatterns");
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
    expect(check({ Dockerfile: `FROM scratch\nRUN ${command}\n` })).toEqual([
      "Dockerfile: command runs another formatter; use bun fmt",
    ]);
  }
  // Mentioning a formatter is not running it.
  expect(
    check({
      "package.json": manifest({ scripts: { docs: "echo prettier-free" } }),
    }),
  ).toEqual([]);
  expect(
    check({ "package.json": manifest({ scripts: { lint: "biome lint ." } }) }),
  ).toEqual([]);
});

test("a package script named fmt would shadow bun fmt", () => {
  expect(
    check({
      "packages/a/package.json": manifest({ scripts: { fmt: "bun fmt" } }),
    }),
  ).toEqual([
    "packages/a/package.json: a package script named fmt shadows bun fmt; remove it",
  ]);
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

test("bunfig.toml [fmt] carries the one shared style", () => {
  const styleError = `bunfig.toml: bunfig.toml [fmt] {key} must equal the shared style:\n${sharedTables}`;
  const shared = (replacement: readonly [string, string]) =>
    check({ "bunfig.toml": bunfig.replace(...replacement) });
  expect(
    check({ "bunfig.toml": bunfig.replaceAll("[fmt", "[format") }),
  ).toEqual([
    `bunfig.toml: bunfig.toml requires a [fmt] table: bun fmt reads its configuration only from there; start from:\n${sharedTables}`,
  ]);
  expect(check({ "bunfig.toml": `[install]\n\n${sharedTables}` })).toEqual([]);
  // No repository keeps its own line width or import order.
  expect(shared(["printWidth = 80", "printWidth = 100"])).toEqual([
    styleError.replace("{key}", "printWidth"),
  ]);
  for (const replacement of [
    ["newlinesBetween = true", "newlinesBetween = false"],
    ['["@stll/**"]', '["@stll/*"]'],
    ['"stella", "aliases"', '"aliases", "stella"'],
  ] as const)
    expect(shared(replacement)).toEqual([
      styleError.replace("{key}", "sortImports"),
    ]);
  // Style keys outside the shared table are not repository choices either.
  expect(shared(["printWidth = 80", "printWidth = 80\nsemi = false"])).toEqual([
    "bunfig.toml: bunfig.toml [fmt] semi is not part of the shared style; every repository formats alike",
  ]);
  expect(
    check({
      "bunfig.toml": `${bunfig}\n[[fmt.overrides]]\nfiles = ["a.ts"]\n`,
    }),
  ).toEqual([
    "bunfig.toml: bunfig.toml [fmt] overrides is not part of the shared style; every repository formats alike",
  ]);
  // Repository-owned keys: extra ignores and the Tailwind entry point.
  expect(
    check({
      "bunfig.toml": `${bunfig}\n[fmt.sortTailwindcss]\nfunctions = ["cn"]\n`,
    }),
  ).toEqual([]);
  expect(shared(['".github/dependabot.yml"', '"dist/**"'])).toEqual([
    "bunfig.toml: bunfig.toml [fmt] ignorePatterns must include the shared generated files: .github/dependabot.yml",
  ]);
});

test("hooks format staged files and CI checks the whole repository", () => {
  expect(toolchainInputKind("lefthook.yml")).toBe("config");
  for (const hook of [
    "pre-commit:\n  commands:\n    format:\n      run: bun fmt --staged {staged_files}\n",
    "pre-commit:\n  commands:\n    format:\n      run: bun fmt\n",
    "pre-push:\n  commands:\n    format:\n      run: bun fmt --staged\n",
    "pre-commit:\n  commands:\n    format:\n      run: bun fmt --staged || true\n",
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
  for (const step of [
    "bun fmt --check src",
    "bun fmt",
    "bun run format",
    "bun fmt --check || true",
  ])
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

test("an ignore pattern that covers a workspace package is rejected", () => {
  const workspace = (workspaces: unknown, patterns: string[]) =>
    check({
      "package.json": manifest({ workspaces }),
      "packages/mcp/package.json": manifest({ name: "mcp" }),
      "packages/benchmark/package.json": manifest({ name: "benchmark" }),
      "npm/linux-x64/package.json": manifest({ name: "binary" }),
      "bunfig.toml": bunfig.replace(
        "ignorePatterns = [",
        `ignorePatterns = [${patterns.map((pattern) => JSON.stringify(pattern)).join(", ")}, `,
      ),
    });
  const narrow = [
    "packages/benchmark/vendor/**",
    "packages/benchmark/results/**",
    "vendor/",
    "**/dist/**",
    "npm/",
  ];
  expect(workspace(["packages/*"], narrow)).toEqual([]);
  expect(workspace({ packages: ["packages/*"] }, narrow)).toEqual([]);
  expect(
    workspace(["packages/*"], ["packages/", "packages/benchmark/**", "**"]),
  ).toEqual([
    "bunfig.toml: bunfig.toml [fmt] ignorePatterns entry packages/ covers workspace packages (packages/mcp, packages/benchmark); ignore only their generated or vendored paths",
    "bunfig.toml: bunfig.toml [fmt] ignorePatterns entry packages/benchmark/** covers workspace packages (packages/benchmark); ignore only their generated or vendored paths",
    "bunfig.toml: bunfig.toml [fmt] ignorePatterns entry ** covers workspace packages (packages/mcp, packages/benchmark); ignore only their generated or vendored paths",
  ]);
  // A leading slash anchors the pattern at the repository root.
  expect(workspace(["packages/*"], ["/mcp/"])).toEqual([]);
  expect(workspace(["packages/*"], ["packages/*/lib/**", "**/*.tsx"])).toEqual([
    "bunfig.toml: bunfig.toml [fmt] ignorePatterns entry packages/*/lib/** covers workspace packages (packages/mcp, packages/benchmark); ignore only their generated or vendored paths",
    "bunfig.toml: bunfig.toml [fmt] ignorePatterns entry **/*.tsx covers workspace packages (packages/mcp, packages/benchmark); ignore only their generated or vendored paths",
  ]);
  // Negations are refused: every repository pattern only removes files.
  expect(
    workspace(["packages/*"], ["packages/**/*.ts", "!packages/mcp/**/*.ts"]),
  ).toEqual([
    "bunfig.toml: bunfig.toml [fmt] ignorePatterns entry !packages/mcp/**/*.ts re-includes files; list only generated or vendored paths",
    "bunfig.toml: bunfig.toml [fmt] ignorePatterns entry packages/**/*.ts covers workspace packages (packages/mcp, packages/benchmark); ignore only their generated or vendored paths",
  ]);
  // A negated workspace pattern leaves that directory outside the workspace.
  expect(
    workspace(["packages/*", "!packages/benchmark"], ["packages/benchmark/"]),
  ).toEqual([]);
  expect(workspace(["packages/*"], ["mcp/", "packages/*/src/**"])).toEqual([
    "bunfig.toml: bunfig.toml [fmt] ignorePatterns entry mcp/ covers workspace packages (packages/mcp); ignore only their generated or vendored paths",
    "bunfig.toml: bunfig.toml [fmt] ignorePatterns entry packages/*/src/** covers workspace packages (packages/mcp, packages/benchmark); ignore only their generated or vendored paths",
  ]);
});

test("only an empty root Prettier YAML mapping may stop ancestor lookup", () => {
  for (const text of [
    "{}\n",
    "# Checkout boundary; options belong in bunfig.toml.\n{}\n",
  ]) {
    expect(
      checkFormatter({
        files: { ...repository, ".prettierrc.yml": text },
        policy,
        usesBun: true,
      }),
    ).toEqual([]);
  }
  for (const [file, text] of [
    [".prettierrc.yml", "semi: false\n"],
    [".prettierrc.yml", "overrides: []\n"],
    [".prettierrc.yml", "null\n"],
    [".prettierrc.yml", "[]\n"],
    [".prettierrc.yml", ""],
    [".prettierrc.yml", "{\n"],
    ["packages/core/.prettierrc.yml", "{}\n"],
    [".prettierrc.json", "{}\n"],
  ] as const) {
    expect(
      checkFormatter({
        files: { ...repository, [file]: text },
        policy,
        usesBun: true,
      }).some((diagnostic) => diagnostic.path === file),
    ).toBe(true);
  }
});

test("declared staged selectors bind the exact hook and never narrow CI", () => {
  const stagedSelector = parseFormatterStagedSelector({
    script: "scripts/staged.ts",
    reason: "Select author-written staged paths, including merge resolutions.",
  });
  const hook =
    "pre-commit:\n  commands:\n    format:\n      files: bun scripts/staged.ts\n      run: bun fmt --staged --ignore-unknown {files}\n";
  const files = {
    ...repository,
    "scripts/staged.ts": "export {};",
    "lefthook.yml": hook,
  };
  expect(
    checkFormatter({ files, policy, usesBun: true, stagedSelector }),
  ).toEqual([]);
  for (const changed of [
    hook.replace("scripts/staged.ts", "scripts/other.ts"),
    hook.replace("{files}", "{staged_files}"),
    hook.replace("{files}", "src/"),
    hook.replace("--staged", "--check"),
    hook.replace("      files:", "      glob: '*.ts'\n      files:"),
    hook.replace("      files:", "      root: packages/core\n      files:"),
    hook.replace("{files}", "{files} || true"),
  ])
    expect(
      checkFormatter({
        files: { ...files, "lefthook.yml": changed },
        policy,
        usesBun: true,
        stagedSelector,
      }).length,
    ).toBeGreaterThan(0);
  expect(
    checkFormatter({
      files: {
        ...files,
        ".github/workflows/ci.yml": workflow.replace(
          "bun fmt --check",
          "bun fmt --check {files}",
        ),
      },
      policy,
      usesBun: true,
      stagedSelector,
    }).length,
  ).toBeGreaterThan(0);
  expect(
    checkFormatter({
      files: { ...repository, "lefthook.yml": hook },
      policy,
      usesBun: true,
      stagedSelector,
    }).length,
  ).toBeGreaterThan(0);
  for (const input of [
    { script: "../outside.ts", reason: "test" },
    { script: "scripts/*.ts", reason: "test" },
    { script: "scripts/a.ts", reason: "" },
    { script: "scripts/a.ts", reason: "test", extra: true },
  ])
    expect(() => parseFormatterStagedSelector(input)).toThrow();
});

test("delegated CI formatting requires declared files and an executable workflow reference", () => {
  const checkSource = parseFormatterCheckSource({
    source: ".github/checks/policy.yml",
    workflow: ".github/workflows/ci.yml",
    job: "policy",
    runner: "scripts/check-pool.ts",
    argument: "policy",
    reason: "The tested pool owns policy check execution.",
  });
  const files = {
    ...repository,
    "scripts/check-pool.ts": "export {};",
    ".github/checks/policy.yml": "checks:\n  - run: bun fmt --check\n",
    ".github/workflows/ci.yml":
      "jobs:\n  policy:\n    steps:\n      - run: CONTEXT=literal exec bun scripts/check-pool.ts run policy\n",
  };
  expect(checkFormatter({ files, policy, usesBun: true, checkSource })).toEqual(
    [],
  );
  for (const command of [
    "echo bun scripts/check-pool.ts run policy",
    "bun scripts/other.ts run policy",
    "bun scripts/check-pool.ts run other",
    "bun scripts/check-pool.ts run $JOB",
  ]) {
    expect(
      checkFormatter({
        files: {
          ...files,
          ".github/workflows/ci.yml": `jobs:\n  policy:\n    steps:\n      - run: ${command}\n`,
        },
        policy,
        usesBun: true,
        checkSource,
      }).length,
    ).toBeGreaterThan(0);
  }
  for (const source of [
    "defaults:\n  run:\n    working-directory: packages/core\n" +
      files[".github/workflows/ci.yml"],
    files[".github/workflows/ci.yml"].replace(
      "      - run:",
      "      - working-directory: packages/core\n        run:",
    ),
  ])
    expect(
      checkFormatter({
        files: { ...files, ".github/workflows/ci.yml": source },
        policy,
        usesBun: true,
        checkSource,
      }).length,
    ).toBeGreaterThan(0);
  for (const omitted of [
    "scripts/check-pool.ts",
    ".github/checks/policy.yml",
    ".github/workflows/ci.yml",
  ]) {
    const incomplete = Object.fromEntries(
      Object.entries(files).filter(([file]) => file !== omitted),
    );
    expect(
      checkFormatter({ files: incomplete, policy, usesBun: true, checkSource })
        .length,
    ).toBeGreaterThan(0);
  }
  expect(
    checkFormatter({
      files: {
        ...files,
        ".github/checks/policy.yml": "checks:\n  - run: bun fmt --check src/\n",
      },
      policy,
      usesBun: true,
      checkSource,
    }).length,
  ).toBeGreaterThan(0);
});
