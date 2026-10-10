/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import {
  githubAutomationFileKind,
  isMiseConfigPath,
  toolchainInputKind,
} from "./toolchain-inputs";
import { checkRuntimeFile, runtimeRules } from "./toolchain-runtime";

const sha = "a".repeat(40);
const policy = {
  bun: "1.4.3",
  node: "22.20.0",
  python: "3.13.7",
  rust: "1.90.0",
  rustCompilerDevelopment: "nightly-2026-04-16",
  packages: { oxlint: "1.87.0", oxfmt: "0.72.0", lefthook: "1.13.0" },
  actions: {
    "actions/checkout": { sha, version: "v5" },
    "actions/setup-node": { sha, version: "v5" },
    "actions/setup-python": { sha, version: "v6" },
    "oven-sh/setup-bun": { sha, version: "v2" },
  },
};
const files: Record<string, string> = {
  "package.json": JSON.stringify({ packageManager: `bun@${policy.bun}` }),
  ".node-version": policy.node,
  ".nvmrc": policy.node,
  ".python-version": policy.python,
};
const check = (
  file: string,
  text: string,
  overrides: Record<string, string> = {},
  selectedPython = policy.python,
) => {
  const entries = { ...files, ...overrides };
  return checkRuntimeFile({
    file,
    text,
    policy: { ...policy, python: selectedPython },
    trackedFiles: new Set(Object.keys(entries)),
    readFile: (name) => entries[name],
  });
};
const workflow = (step: string) => `jobs:\n  test:\n    steps:\n${step}`;
const cases = [
  { rule: "bun-pins", file: ".bun-version", pass: policy.bun, fail: "1.4.0" },
  {
    rule: "bun-pins",
    file: ".github/workflows/ci.yml",
    pass: workflow(
      `      - uses: oven-sh/setup-bun@${sha} # v2\n        with: {bun-version-file: package.json}`,
    ),
    fail: workflow(`      - uses: oven-sh/setup-bun@${sha} # v2`),
  },
  { rule: "node-version", file: ".nvmrc", pass: "22.20.0", fail: "22" },
  {
    rule: "python-version",
    file: "pyproject.toml",
    pass: '[project]\nrequires-python = "==3.13.7"',
    fail: '[project]\nrequires-python = ">=3.14"',
  },
  {
    rule: "rust-version",
    file: "rust-toolchain.toml",
    pass: '[toolchain]\nchannel = "1.90.0"',
    fail: '[toolchain]\nchannel = "stable"',
  },
  {
    rule: "runtime-manager",
    file: "mise.toml",
    pass: '[tools]\nnode = "22.20.0"\noxlint = "1.87.0"',
    fail: '[tools]\nnode = "22.20.0"\noxlint = "latest"',
  },
  {
    rule: "runtime-docker",
    file: "Dockerfile",
    pass: "FROM --platform=linux/arm64 node:22.20.0-alpine",
    fail: "FROM --platform=linux/arm64 node:22-alpine",
  },
  {
    rule: "runtime-workflow",
    file: ".github/workflows/ci.yml",
    pass: workflow(
      `      - uses: actions/setup-node@${sha} # v5\n        with: { node-version-file: .node-version }`,
    ),
    fail: workflow(
      `      - uses: actions/setup-node@${sha} # v5\n        with: { node-version: '22.20.0' }`,
    ),
  },
  {
    rule: "action-pins",
    file: ".github/actions/install/action.yml",
    pass: `runs:\n  using: composite\n  steps:\n    - uses: 'actions/checkout@${sha}' # v5`,
    fail: "runs:\n  using: composite\n  steps:\n    - uses: 'actions/checkout@v5' # v5",
  },
] satisfies {
  rule: (typeof runtimeRules)[number];
  file: string;
  pass: string;
  fail: string;
}[];

test("fixture coverage equals the declared runtime rules", () => {
  expect(new Set(cases.map(({ rule }) => rule))).toEqual(new Set(runtimeRules));
});
for (const fixture of cases) {
  test(`${fixture.rule} accepts its shared pin and rejects a mutation`, () => {
    expect(check(fixture.file, fixture.pass)).toEqual([]);
    const diagnostics = check(fixture.file, fixture.fail);
    expect(diagnostics.some(({ rule }) => rule === fixture.rule)).toBe(true);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.path).toBe(fixture.file);
      expect(diagnostic.line).toBeGreaterThan(0);
    }
  });
}

test("all supported runtime file forms reject floating pins", () => {
  for (const [file, pass, fail] of [
    [".node-version", policy.node, "lts/*"],
    [".python-version", policy.python, "3.13"],
    ["rust-toolchain", policy.rust, "nightly"],
    ["uv.toml", `python = '${policy.python}'`, "python = '3.13'"],
    [
      "pyproject.toml",
      `[tool.uv]\npython = '${policy.python}'`,
      "[tool.uv]\npython = '3.13'",
    ],
    [
      ".tool-versions",
      `nodejs ${policy.node}\npython ${policy.python}\nrust ${policy.rust}\nbun ${policy.bun}\nlefthook 1.13.0`,
      "nodejs 22\npython 3.13\nrust stable\nbun latest\nlefthook latest",
    ],
    [
      "Containerfile",
      `FROM python:${policy.python}-slim`,
      "FROM python:3.13-slim",
    ],
  ]) {
    if (file === undefined || pass === undefined || fail === undefined)
      throw new Error("incomplete fixture");
    expect(check(file, pass)).toEqual([]);
    expect(check(file, fail).length).toBeGreaterThan(0);
  }
});

test("setup runtime files must be tracked and contain the shared exact pin", () => {
  const content = workflow(
    `      - uses: actions/setup-python@${sha} # v6\n        with: {python-version-file: .python-version}`,
  );
  expect(check(".github/workflows/ci.yml", content)).toEqual([]);
  expect(
    check(".github/workflows/ci.yml", content, {
      ".python-version": "3.12.0",
    }).some(({ rule }) => rule === "runtime-workflow"),
  ).toBe(true);
  for (const reference of [
    "../.python-version",
    "untracked/.python-version",
    "${{ inputs.file }}",
    "/.python-version",
  ])
    expect(
      check(
        ".github/workflows/ci.yml",
        content.replace(".python-version", reference),
      ).length,
    ).toBeGreaterThan(0);
});

test("mise inline tools and npm backends share the same exact pins", () => {
  expect(
    check(
      "mise.toml",
      '[tools]\n"npm:oxlint" = {version = "1.87.0"}\n"core:node" = "22.20.0"',
    ),
  ).toEqual([]);
  expect(
    check(
      "mise.toml",
      '[tools]\n"npm:oxlint" = {version = "latest"}\n"core:node" = "22"',
    ).filter(({ rule }) => rule === "runtime-manager"),
  ).toHaveLength(2);
});

test("requires-python ranges include the shared Python release", () => {
  for (const requirement of [
    ">=3.12,<3.14",
    "~=3.13",
    "==3.13.*",
    ">=3.13,!=3.12.*",
    "<3.14.0",
    "<=3.14",
    "~=3.13.0",
    "==3.*",
    "!=3.12.7",
  ])
    expect(
      check(
        "pyproject.toml",
        `[project]\nrequires-python = '${requirement}'`,
        {},
        "3.13",
      ),
    ).toEqual([]);
  for (const requirement of [
    ">=3.14",
    "<3.13",
    "!=3.13.*",
    "~=3.13.1",
    "==3.12.*",
    "~=3",
    ">=3.12.*",
    "garbage",
    "",
    ">=3.13,",
    ">3.13.0",
    "<=3.13.0",
    "==3.13.0",
    "!=3.13.7",
    "!=3.13.1000000",
    "!=3.13.7.*",
    ">=3.13.1,<3.14",
    "<3.13.1000000",
    "<=3.13.9999999999999999999999",
  ])
    expect(
      check(
        "pyproject.toml",
        `[project]\nrequires-python = '${requirement}'`,
        {},
        "3.13",
      ).some(({ rule }) => rule === "python-version"),
    ).toBe(true);
});

test("patch Python policy still checks a single exact release against support constraints", () => {
  for (const requirement of [
    ">3.13.0",
    "==3.13.7",
    "<=3.13.7",
    ">=3.13.6,!=3.13.8",
    "~=3.13.1",
    "!=3.13.0",
  ])
    expect(
      check("pyproject.toml", `[project]\nrequires-python = '${requirement}'`),
    ).toEqual([]);
  expect(
    check("pyproject.toml", "[project]\nrequires-python = '!=3.13.7'").some(
      ({ rule }) => rule === "python-version",
    ),
  ).toBe(true);
});

test("mise environment and configuration layouts share discovery and version checks", () => {
  const paths = [
    "mise.ci.toml",
    ".mise.ci.toml",
    "tools/mise.production.toml",
    "mise.production.local.toml",
    "tools/.mise.local.toml",
    "mise/config.ci.toml",
    ".mise/config.local.toml",
    ".config/mise.toml",
    ".config/mise/config.production.toml",
    "mise/conf.d/node-tools.toml",
    ".mise/conf.d/node.toml",
    ".config/mise/conf.d/tools.toml",
  ];
  for (const file of paths) {
    expect(isMiseConfigPath(file)).toBe(true);
    expect(toolchainInputKind(file)).toBe("config");
    const content = `[tools]\nnode = '${policy.node}'\nbun = '${policy.bun}'`;
    expect(check(file, content)).toEqual([]);
    expect(
      check(file, content.replace(policy.node, "latest")).some(
        ({ rule }) => rule === "runtime-manager",
      ),
    ).toBe(true);
  }
  for (const file of [
    "config.ci.toml",
    "mise.ci.toml.backup",
    "mise/conf.d/.hidden.toml",
    "vendor/mise.ci.toml",
    "node_modules/example/mise.toml",
  ])
    expect(isMiseConfigPath(file)).toBe(false);
});

test("minor Python policy preserves explicit patch selectors within its release series", () => {
  expect(check(".python-version", "3.13", {}, "3.13")).toEqual([]);
  expect(check(".python-version", "3.13.7", {}, "3.13")).toEqual([]);
  expect(check("Containerfile", "FROM python:3.13.7-slim", {}, "3.13")).toEqual(
    [],
  );
  for (const version of ["3.12.7", "3", "3.13rc1", "3.13.7.post1"])
    expect(
      check(".python-version", version, {}, "3.13").length,
    ).toBeGreaterThan(0);
  expect(check(".python-version", "3.13.8").length).toBeGreaterThan(0);
});

test("quoted and flow action pins still require the matching SHA and version comment", () => {
  const file = ".github/workflows/ci.yml";
  expect(
    check(file, workflow(`      - {uses: "actions/checkout@${sha}"} # v5`)),
  ).toEqual([]);
  for (const step of [
    `      - {uses: "actions/checkout@${sha}"} # v4`,
    `      - {uses: "actions/checkout@${"b".repeat(40)}"} # v5`,
    `      - {uses: "actions/checkout@${sha}"}`,
    "      - uses: external/action@main # v1",
    "      - uses: external/action",
  ])
    expect(
      check(file, workflow(step)).some(({ rule }) => rule === "action-pins"),
    ).toBe(true);
  expect(check(file, workflow(`      - uses: external/action@${sha}`))).toEqual(
    [],
  );
  expect(
    check(file, workflow(`      - uses: external/action@${sha} # v1`)),
  ).toEqual([]);
  expect(check(file, workflow("      - uses: ./local/action"))).toEqual([]);
});

test("Docker image actions require an explicit action-pins decision", () => {
  for (const reference of [
    "docker://alpine:3",
    `docker://alpine@sha256:${"a".repeat(64)}`,
    `docker://alpine@${sha}`,
  ])
    expect(
      check(
        ".github/workflows/ci.yml",
        workflow(`      - uses: ${reference}`),
      ).some(({ rule }) => rule === "action-pins"),
    ).toBe(true);
});

test("resolved aliases and merge keys cannot hide runtime declarations", () => {
  const file = ".github/workflows/ci.yml";
  const content = `step: &setup\n  uses: actions/setup-node@${sha} # v5\n  with: {node-version-file: .node-version}\njobs:\n  test:\n    steps:\n      - <<: *setup\n        with: {node-version: '22'}\n`;
  expect(
    check(file, content).some(({ rule }) => rule === "runtime-workflow"),
  ).toBe(true);
  expect(
    check(
      file,
      `step: &action {uses: actions/checkout@v5}\njobs: {test: {steps: [*action]}}`,
    ).some(({ rule }) => rule === "action-pins"),
  ).toBe(true);
  expect(
    check(
      file,
      `job-definitions: &jobs\n  test:\n    steps:\n      - uses: actions/checkout@v1\njobs:\n  <<: *jobs\n`,
    ).some(({ rule }) => rule === "action-pins"),
  ).toBe(true);
  expect(
    check(
      file,
      `step: &base {uses: actions/checkout@${sha}} # v5\njobs:\n  test:\n    steps:\n      - <<: *base\n`,
    ),
  ).toEqual([]);
});

test("one matching action occurrence cannot supply another occurrence's comment", () => {
  expect(
    check(
      ".github/workflows/ci.yml",
      workflow(
        `      - uses: actions/checkout@${sha}\n      - uses: actions/checkout@${sha} # v5`,
      ),
    ).some(({ rule }) => rule === "action-pins"),
  ).toBe(true);
});

test("invalid selected config is diagnosed; unrelated files are ignored", () => {
  expect(
    check("mise.toml", "[tools\nnode = '22'").some(
      ({ rule }) => rule === "runtime-manager",
    ),
  ).toBe(true);
  expect(
    check(".github/workflows/ci.yml", "jobs: [").some(
      ({ rule }) => rule === "runtime-workflow",
    ),
  ).toBe(true);
  expect(
    check("README.md", "FROM node:latest\nuses: actions/checkout@v5"),
  ).toEqual([]);
});

test("action policy follows GitHub repository case normalization", () => {
  expect(
    check(
      ".github/workflows/ci.yml",
      workflow(`      - uses: Actions/Checkout@${sha} # v5`),
    ),
  ).toEqual([]);
  expect(
    check(
      ".github/workflows/ci.yml",
      workflow(`      - uses: Actions/Checkout@${"b".repeat(40)}`),
    ).some(({ rule }) => rule === "action-pins"),
  ).toBe(true);
  expect(
    check(
      ".github/workflows/ci.yml",
      workflow(
        `      - uses: Actions/Setup-Node@${sha} # v5\n        with: {node-version: 22}`,
      ),
    ).some(({ rule }) => rule === "runtime-workflow"),
  ).toBe(true);
});

test("only executable action declarations are checked", () => {
  const file = ".github/workflows/ci.yml";
  expect(
    check(
      file,
      `env: {uses: 'actions/checkout@${sha}'}\njobs:\n  test:\n    steps:\n      - run: |\n          uses: actions/checkout@v1\n          node-version: 22\n      - uses: actions/checkout@${sha} # v5\n`,
    ),
  ).toEqual([]);
  expect(
    check(
      file,
      `jobs:\n  test:\n    uses: external/repository/.github/workflows/ci.yml@main`,
    ),
  ).toHaveLength(1);
  expect(
    check(
      ".github/actions/js/action.yml",
      "inputs: {uses: {default: example}}\nruns: {using: node24, main: index.js}",
    ),
  ).toEqual([]);
});

test("Docker image arguments resolve defaults without treating stage arguments as global", () => {
  expect(
    check(
      "Dockerfile",
      `ARG VERSION=${policy.node}\nARG IMAGE=node:$VERSION\nFROM \\\n  --platform=linux/arm64 \\\n  $IMAGE AS base\nFROM base AS final\n`,
    ),
  ).toEqual([]);
  const invalid = check(
    "Dockerfile",
    `ARG IMAGE=node:latest\nFROM alpine:3 AS first\nARG IMAGE=node:${policy.node}\nFROM $IMAGE`,
  );
  expect(
    invalid.some(({ rule, line }) => rule === "runtime-docker" && line === 4),
  ).toBe(true);
  expect(
    check("Dockerfile", "ARG BASE\nFROM $BASE").some(({ message }) =>
      message.includes("cannot determine"),
    ),
  ).toBe(true);
  for (const prefix of [
    "library/",
    "docker.io/",
    "index.docker.io/library/",
    "registry-1.docker.io/library/",
  ])
    expect(
      check("Dockerfile", `FROM ${prefix}node:latest`).some(
        ({ rule }) => rule === "runtime-docker",
      ),
    ).toBe(true);
});

test("Docker heredocs contain text rather than image declarations", () => {
  expect(
    check(
      "Dockerfile",
      `FROM node:${policy.node}\nRUN <<EOF\nFROM python:latest\nEOF\nCOPY <<-EOF /example\n\tFROM node:latest\n\tEOF\n`,
    ),
  ).toEqual([]);
});

test("Docker escape directives preserve multiline FROM checks", () => {
  expect(
    check("Dockerfile", "# escape=`\nFROM `\n node:latest").some(
      ({ rule, line }) => rule === "runtime-docker" && line === 2,
    ),
  ).toBe(true);
});

test("semantic Bun setup requires a tracked packageManager source and rejects literals", () => {
  const file = ".github/workflows/ci.yml";
  const step = `      - uses: Oven-Sh/Setup-Bun@${sha} # v2\n        with: {bun-version-file: package.json}`;
  expect(check(file, workflow(step))).toEqual([]);
  expect(
    check(file, workflow(step), {
      "package.json": JSON.stringify({ packageManager: "bun@1.4.0" }),
    }).some(({ rule }) => rule === "bun-pins"),
  ).toBe(true);
  for (const reference of [
    "untracked/package.json",
    "../package.json",
    "${{ inputs.file }}",
    ".node-version",
    "/package.json",
  ])
    expect(
      check(
        file,
        workflow(step.replace("package.json", `'${reference}'`)),
      ).some(({ rule }) => rule === "bun-pins"),
    ).toBe(true);
  expect(
    check(
      file,
      workflow(
        step.replace("bun-version-file: package.json", "bun-version: 1.4.3"),
      ),
    ).some(({ rule }) => rule === "bun-pins"),
  ).toBe(true);
  expect(
    check(file, workflow(step), { "package.json": "[]" }).some(
      ({ rule }) => rule === "bun-pins",
    ),
  ).toBe(true);
  expect(
    check(file, workflow(step), { "package.json": "{" }).some(
      ({ rule }) => rule === "bun-pins",
    ),
  ).toBe(true);
  expect(
    check(file, workflow(step.replace("package.json", "./package.json"))),
  ).toEqual([]);
  expect(
    check(file, workflow(step), { "package.json": "{}" }).some(
      ({ rule }) => rule === "bun-pins",
    ),
  ).toBe(true);
  expect(
    check(
      file,
      `env: {bun-version: '1.4.0'}\njobs:\n  test:\n    steps:\n      - run: |\n          bun-version: 1.4.0\n      - uses: oven-sh/setup-bun@${sha} # v2\n        with: {bun-version-file: package.json}`,
    ),
  ).toEqual([]);
  expect(
    check(
      file,
      `input: &pin {bun-version: '1.4.0'}\njobs:\n  test:\n    steps:\n      - uses: oven-sh/setup-bun@${sha} # v2\n        with: *pin`,
    ).some(({ rule }) => rule === "bun-pins"),
  ).toBe(true);
});

test("all semantic Bun manager forms retain the shared exact pin", () => {
  for (const pass of [
    `[tools]\nbun = '${policy.bun}'`,
    `[tools]\nbun = { version = '${policy.bun}', os = ['linux'] }`,
    `tools.bun = '${policy.bun}'`,
    `[tools.bun]\nversion = '${policy.bun}'`,
    `tools = { bun = '${policy.bun}' }`,
    `tools = { bun = {version = '${policy.bun}'} }`,
  ]) {
    expect(check("mise.toml", pass)).toEqual([]);
    expect(
      check("mise.toml", pass.replace(policy.bun, "latest")).some(
        ({ rule }) => rule === "runtime-manager",
      ),
    ).toBe(true);
  }
  expect(check(".tool-versions", `bun ${policy.bun}\n`)).toEqual([]);
  expect(
    check(".tool-versions", "bun latest\n").some(
      ({ rule }) => rule === "runtime-manager",
    ),
  ).toBe(true);
});

test("Bun Docker declarations use the same semantic instruction parser", () => {
  expect(
    check(
      "Dockerfile",
      `ARG IMAGE=oven/bun:${policy.bun}-alpine\nFROM $IMAGE\nRUN <<EOF\nFROM oven/bun:latest\nEOF\n`,
    ),
  ).toEqual([]);
  const diagnostics = check(
    "Dockerfile",
    "ARG IMAGE=oven/bun:latest\nFROM \\\n $IMAGE\n",
  );
  expect(
    diagnostics.some(({ rule, line }) => rule === "bun-pins" && line === 2),
  ).toBe(true);
  for (const content of [
    "FROM oven/bun",
    "FROM docker.io/oven/bun:latest",
    "FROM oven/bun@sha256:example",
  ])
    expect(
      check("Dockerfile", content).some(({ rule }) => rule === "bun-pins"),
    ).toBe(true);
});

test("Rust TOML uses the same channel rule under either supported filename", () => {
  for (const file of ["rust-toolchain", "rust-toolchain.toml"]) {
    expect(
      check(
        file,
        `# selected release\n[toolchain]\nchannel = '${policy.rust}'`,
      ),
    ).toEqual([]);
    expect(
      check(file, "[toolchain]\nchannel = 'stable'").some(
        ({ rule }) => rule === "rust-version",
      ),
    ).toBe(true);
  }
});

test("Rust compiler development selects its explicit pin only with rustc-dev", () => {
  for (const file of ["rust-toolchain", "rust-toolchain.toml"]) {
    const declaration = `[toolchain]\nchannel = '${policy.rustCompilerDevelopment}'\ncomponents = ['rustc-dev', 'rust-src']`;
    expect(check(file, declaration)).toEqual([]);
    for (const mutation of [
      declaration.replace(policy.rustCompilerDevelopment, "nightly-2026-04-15"),
      declaration.replace("'rustc-dev', ", ""),
      declaration.replace(policy.rustCompilerDevelopment, policy.rust),
    ])
      expect(
        check(file, mutation).some(({ rule }) => rule === "rust-version"),
      ).toBe(true);
  }
  expect(
    check("rust-toolchain", policy.rustCompilerDevelopment).some(
      ({ rule }) => rule === "rust-version",
    ),
  ).toBe(true);
  expect(check("mise.toml", `[tools]\nrust = '${policy.rust}'`)).toEqual([]);
  expect(
    check(
      "mise.toml",
      `[tools]\nrust = '${policy.rustCompilerDevelopment}'`,
    ).some(({ rule }) => rule === "runtime-manager"),
  ).toBe(true);
});

test("action metadata is checked at the root and in arbitrary directories", () => {
  for (const file of [
    "action.yml",
    "action.yaml",
    "actions/build/action.yml",
    "tools/nested/action.yaml",
    ".github/actions/build/action.yml",
  ]) {
    expect(githubAutomationFileKind(file)).toBe("action");
    const content = `runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@${sha} # v5\n`;
    expect(check(file, content)).toEqual([]);
    expect(
      check(file, content.replace(sha, "main")).some(
        ({ rule }) => rule === "action-pins",
      ),
    ).toBe(true);
  }
  expect(githubAutomationFileKind(".github/workflows/ci.yaml")).toBe(
    "workflow",
  );
  for (const file of [
    "README.md",
    "action.yml.txt",
    "actions/build/actions.yml",
    "examples/workflow.yaml",
  ])
    expect(githubAutomationFileKind(file)).toBeUndefined();
});

test("self-repository actions and workflows use their running commit without a ref", () => {
  const actions = ["$/actions/build", "$/.github/actions/build"];
  for (const reference of actions) {
    expect(
      check(".github/workflows/ci.yml", workflow(`      - uses: ${reference}`)),
    ).toEqual([]);
    expect(
      check(
        "action.yml",
        `runs: {using: composite, steps: [{uses: '${reference}'}]}`,
      ),
    ).toEqual([]);
    for (const suffix of ["@main", `@${sha}`])
      expect(
        check(
          "action.yml",
          `runs: {using: composite, steps: [{uses: '${reference}${suffix}'}]}`,
        ).some(({ rule }) => rule === "action-pins"),
      ).toBe(true);
  }
  expect(
    check(
      ".github/workflows/ci.yml",
      "jobs: {test: {uses: '$/.github/workflows/shared.yml'}}",
    ),
  ).toEqual([]);
  for (const reference of [
    "$/",
    "$/actions/build step",
    "$/../outside",
    "$/actions/${{ inputs.action }}",
    "$\\actions\\build",
  ])
    expect(
      check(
        "action.yml",
        `runs: {using: composite, steps: [{uses: '${reference}'}]}`,
      ).some(({ rule }) => rule === "action-pins"),
    ).toBe(true);
});

test("every shared Docker definition suffix enforces base image pins", () => {
  for (const name of [
    "Dockerfile",
    "Dockerfile.production",
    "Containerfile",
    "Containerfile.production",
  ]) {
    const file = `images/${name}`;
    expect(toolchainInputKind(file)).toBe("config");
    expect(check(file, `FROM node:${policy.node}`)).toEqual([]);
    expect(
      check(file, "FROM node:latest").some(
        ({ rule }) => rule === "runtime-docker",
      ),
    ).toBe(true);
  }
});

test("workflow containers and services share Docker runtime pin validation", () => {
  for (const image of ["node", "python", "oven/bun"]) {
    const version =
      image === "node"
        ? policy.node
        : image === "python"
          ? policy.python
          : policy.bun;
    const rule = image === "oven/bun" ? "bun-pins" : "runtime-docker";
    for (const declaration of [
      `container: ${image}:VERSION`,
      `container: {image: ${image}:VERSION}`,
      `services: {runtime: {image: ${image}:VERSION}}`,
      `services: {runtime: ${image}:VERSION}`,
      `container: &image {image: ${image}:VERSION}\n    services: {runtime: *image}`,
      `services: {runtime: {<<: &image {image: ${image}:VERSION}}}`,
    ]) {
      const source = `jobs:\n  test:\n    ${declaration}\n    steps: []`;
      expect(
        check(
          ".github/workflows/ci.yml",
          source.replaceAll("VERSION", version),
        ),
      ).toEqual([]);
      expect(
        check(
          ".github/workflows/ci.yml",
          source.replaceAll("VERSION", "latest"),
        ).some((entry) => entry.rule === rule),
      ).toBe(true);
    }
  }
  expect(
    check(
      ".github/workflows/ci.yml",
      "jobs:\n  test:\n    container: '${{ matrix.image }}'\n    services: {redis: {image: redis:7}}\n    steps: []",
    ).some(({ rule }) => rule === "runtime-docker"),
  ).toBe(true);
  expect(
    check(
      ".github/workflows/ci.yml",
      "jobs:\n  test:\n    container: ubuntu:24.04\n    services: {redis: {image: redis:7}}\n    steps: []",
    ),
  ).toEqual([]);
});

test("Docker action metadata requires opt-out and validates runtime images", () => {
  for (const image of ["node", "python", "oven/bun"]) {
    const version =
      image === "node"
        ? policy.node
        : image === "python"
          ? policy.python
          : policy.bun;
    const rule = image === "oven/bun" ? "bun-pins" : "runtime-docker";
    for (const file of ["action.yml", "nested/action.yaml"]) {
      const source = (tag: string) =>
        `runs: &runs\n  using: docker\n  image: docker://${image}:${tag}`;
      expect(check(file, source(version)).map(({ rule }) => rule)).toEqual([
        "action-pins",
      ]);
      expect(check(file, source("latest")).map(({ rule }) => rule)).toEqual([
        "action-pins",
        rule,
      ]);
      const alias = `defaults: &docker {using: docker, image: 'docker://${image}:latest'}\nruns: {<<: *docker}`;
      expect(check(file, alias).map(({ rule }) => rule)).toEqual([
        "action-pins",
        rule,
      ]);
    }
    expect(
      check(
        ".github/workflows/ci.yml",
        workflow(`      - uses: docker://${image}:latest`),
      ).map(({ rule }) => rule),
    ).toEqual(["action-pins", rule]);
  }
  for (const file of ["Dockerfile", "./Dockerfile", "docker/Dockerfile"])
    expect(
      check("action.yml", `runs: {using: docker, image: '${file}'}`),
    ).toEqual([]);
  expect(
    check("action.yml", "runs: {using: docker, image: 'docker://redis:7'}").map(
      ({ rule }) => rule,
    ),
  ).toEqual(["action-pins"]);
  expect(
    check(
      "action.yml",
      "runs: {using: node24, main: index.js}\nexample: {image: 'docker://node:latest'}",
    ),
  ).toEqual([]);
});

test("Docker action local paths stay inside the repository and use the documented filename", () => {
  for (const file of ["action.yml", "nested/action.yml"]) {
    for (const image of [
      "/Dockerfile",
      "C:/Dockerfile",
      "..\\Dockerfile",
      "../../Dockerfile",
      "docker://example/Dockerfile",
      "Containerfile.production",
      "Dockerfile.production",
    ])
      expect(
        check(file, `runs: {using: docker, image: '${image}'}`).some(
          ({ rule }) => rule === "action-pins",
        ),
      ).toBe(true);
    expect(
      check(file, "runs: {using: docker, image: 'node/Dockerfile'}"),
    ).toEqual([]);
  }
  expect(
    check("nested/action.yml", "runs: {using: docker, image: '../Dockerfile'}"),
  ).toEqual([]);
  expect(
    check("action.yml", "runs: {using: docker, image: '../Dockerfile'}").some(
      ({ rule }) => rule === "action-pins",
    ),
  ).toBe(true);
});

test("aliases for whole service tables cannot hide runtime images", () => {
  for (const image of ["node", "python", "oven/bun"]) {
    const rule = image === "oven/bun" ? "bun-pins" : "runtime-docker";
    const source = `defaults: &services\n  runtime: &runtime {image: '${image}:latest'}\njobs:\n  test:\n    services: *services\n    steps: []`;
    expect(
      check(".github/workflows/ci.yml", source).map((entry) => entry.rule),
    ).toEqual([rule]);
  }
});

test("prefixed runtime selectors map only preceding matching source snapshots", () => {
  const checkout = (options: string) =>
    `      - uses: actions/checkout@${sha} # v5\n        with: {${options}}`;
  const checkSource = (
    text: string,
    extraFiles: Record<string, string> = {},
  ) => {
    const entries = { ...files, ...extraFiles };
    return checkRuntimeFile({
      file: ".github/workflows/ci.yml",
      text,
      policy,
      repository: "stella/example",
      trackedFiles: new Set(Object.keys(entries)),
      readFile: (file) => entries[file],
    });
  };
  for (const [action, version, tool, target] of [
    ["actions/setup-node", "v5", "node", ".node-version"],
    ["actions/setup-python", "v6", "python", ".python-version"],
    ["oven-sh/setup-bun", "v2", "bun", "package.json"],
  ]) {
    const setup = (prefix: string) =>
      `      - uses: ${action}@${sha} # ${version}\n        with: {${tool}-version-file: '${prefix}${target}'}`;
    const rule = tool === "bun" ? "bun-pins" : "runtime-workflow";
    for (const repo of [
      undefined,
      "stella/example",
      "STELLA/EXAMPLE",
      "${{ github.repository }}",
      "${{ job.workflow_repository }}",
      "other/repository",
    ]) {
      for (const revision of [
        undefined,
        sha,
        "${{ job.workflow_sha }}",
        "${{ github.sha }}",
        "main",
        "v1",
      ]) {
        const binding = checkout(
          `${repo === undefined ? "" : `repository: '${repo}', `}${revision === undefined ? "" : `ref: '${revision}', `}path: source`,
        );
        const trusted =
          (repo === "${{ job.workflow_repository }}" &&
            revision === "${{ job.workflow_sha }}") ||
          (revision === undefined &&
            repo !== "${{ job.workflow_repository }}" &&
            repo !== "other/repository");
        const mapped = checkSource(
          workflow(`${binding}\n${setup("source/")}`),
          { [`source/${target}`]: files[target] ?? "" },
        );
        expect(mapped.some((entry) => entry.rule === rule)).toBe(!trusted);
        if (!trusted) continue;
        expect(
          checkSource(workflow(`${setup("source/")}\n${binding}`)).some(
            (entry) => entry.rule === rule,
          ),
        ).toBe(true);
        expect(
          checkSource(
            `jobs:\n  first:\n    steps:\n${binding}\n  second:\n    steps:\n${setup("source/")}`,
          ).some((entry) => entry.rule === rule),
        ).toBe(true);
        expect(
          checkSource(workflow(`${binding}\n${setup("source/")}`), {
            [target]: "invalid",
          }).some((entry) => entry.rule === rule),
        ).toBe(true);
      }
    }
    for (const options of [
      "repository: other/repository, ref: '" + sha + "', path: source",
      "repository: other/repository, ref: '${{ job.workflow_sha }}', path: source",
      "repository: '${{ job.workflow_repository }}', ref: main, path: source",
      "repository: '${{ job.workflow_repository }}', ref: v1, path: source",
      "repository: '${{ job.workflow_repository }}', ref: '${{ github.sha }}', path: source",
      "repository: stella/example, ref: main, path: source",
      "repository: stella/example, ref: v1, path: source",
      "repository: stella/example, ref: '${{ github.sha }}', path: source",
      "repository: stella/example, path: '../source'",
      "repository: stella/example, path: '/source'",
      "repository: stella/example, path: 'C:/source'",
      "repository: stella/example, path: 'source\\nested'",
    ]) {
      // A real tracked shadow target must never rescue a foreign/mutable binding.
      expect(
        checkSource(workflow(`${checkout(options)}\n${setup("source/")}`), {
          [`source/${target}`]: files[target] ?? "",
        }).some((entry) => entry.rule === rule),
      ).toBe(true);
    }
    const reusable = checkout(
      "repository: '${{ job.workflow_repository }}', ref: '${{ job.workflow_sha }}', path: source",
    );
    expect(
      checkSource(workflow(`${reusable}\n${setup("source/")}`), {
        [target]: "invalid",
      }).some((entry) => entry.rule === rule),
    ).toBe(true);
    expect(
      checkSource(workflow(`${reusable}\n${setup("source/missing/")}`)).some(
        (entry) => entry.rule === rule,
      ),
    ).toBe(true);
    const pinned = checkout("repository: stella/example, path: source");
    const foreign = checkout(
      `repository: other/repository, ref: '${sha}', path: source`,
    );
    expect(
      checkSource(workflow(`${pinned}\n${foreign}\n${setup("source/")}`)).some(
        (entry) => entry.rule === rule,
      ),
    ).toBe(true);
    expect(
      checkSource(workflow(`${foreign}\n${pinned}\n${setup("source/")}`)).some(
        (entry) => entry.rule === rule,
      ),
    ).toBe(true);
    expect(
      checkSource(
        workflow(`${checkout("repository: other/repository")}\n${setup("")}`),
      ).some((entry) => entry.rule === rule),
    ).toBe(true);
    expect(
      checkSource(workflow(`${checkout("ref: main")}\n${setup("")}`)).some(
        (entry) => entry.rule === rule,
      ),
    ).toBe(true);
    expect(
      checkSource(
        workflow(`      - uses: actions/checkout@${sha} # v5\n${setup("")}`),
      ),
    ).toEqual([]);
    expect(
      checkSource(workflow(`${pinned}\n${setup("source/../")}`)).some(
        (entry) => entry.rule === rule,
      ),
    ).toBe(true);
  }
});

test("current root checkout spelling preserves selectors and unknown paths fail only when selected", () => {
  for (const prefix of [".", "./"]) {
    expect(
      check(
        ".github/workflows/ci.yml",
        workflow(
          `      - uses: actions/checkout@${sha} # v5\n        with: {path: '${prefix}'}\n      - uses: actions/setup-node@${sha} # v5\n        with: {node-version-file: .node-version}`,
        ),
      ),
    ).toEqual([]);
  }
  for (const prefix of [
    "${{ inputs.path }}",
    "../source",
    "/source",
    "C:/source",
    "source\\nested",
  ]) {
    const checkout = `      - uses: actions/checkout@${sha} # v5\n        with: {path: '${prefix}'}`;
    expect(check(".github/workflows/ci.yml", workflow(checkout))).toEqual([]);
    expect(
      check(
        ".github/workflows/ci.yml",
        workflow(
          `${checkout}\n      - uses: actions/setup-node@${sha} # v5\n        with: {node-version-file: .node-version}`,
        ),
      ).some(({ rule }) => rule === "runtime-workflow"),
    ).toBe(true);
  }
});

test("mapped runtime provenance requires an unconditional unique checkout destination", () => {
  for (const [tool, action, version, target, rule] of [
    ["node", "actions/setup-node", "v5", ".node-version", "runtime-workflow"],
    [
      "python",
      "actions/setup-python",
      "v6",
      ".python-version",
      "runtime-workflow",
    ],
    ["bun", "oven-sh/setup-bun", "v2", "package.json", "bun-pins"],
  ]) {
    const trusted = `      - uses: actions/checkout@${sha} # v5\n        with: {repository: '\${{ job.workflow_repository }}', ref: '\${{ job.workflow_sha }}', path: source}`;
    const setup = `      - uses: ${action}@${sha} # ${version}\n        with: {${tool}-version-file: source/${target}}`;
    const fails = (steps: string, defaults = "") =>
      check(".github/workflows/ci.yml", `${defaults}${workflow(steps)}`).some(
        (entry) => entry.rule === rule,
      );
    expect(fails(`${trusted}\n${setup}`)).toBe(false);
    for (const field of [
      "if: true",
      "if: false",
      "if:",
      "if: '${{ inputs.enabled }}'",
      "continue-on-error: true",
      "continue-on-error: false",
      "continue-on-error:",
    ]) {
      const conditional = `${trusted}\n        ${field}`;
      expect(fails(`${conditional}\n${setup}`)).toBe(true);
      const foreign = `      - uses: actions/checkout@${sha} # v5\n        with: {repository: other/repository, path: source}`;
      expect(fails(`${foreign}\n${conditional}\n${setup}`)).toBe(true);
    }
    for (const path of ["source", "./source", "source/", "source/./"]) {
      for (const ref of [sha, "main"]) {
        const other = `      - uses: actions/checkout@${ref}\n        if: false\n        with: {repository: other/repository, path: '${path}'}`;
        for (const steps of [
          `${other}\n${trusted}\n${setup}`,
          `${trusted}\n${other}\n${setup}`,
          `${trusted}\n${setup}\n${other}`,
        ])
          expect(fails(steps)).toBe(true);
      }
    }
    const alias = `defaults: &other {uses: 'actions/checkout@${sha}', with: {repository: other/repository, path: source}}\n`;
    expect(fails(`${trusted}\n${setup}\n      - <<: *other`, alias)).toBe(true);
    const conditionalAlias = `defaults: &condition {if: false}\n`;
    expect(
      fails(`${trusted}\n        <<: *condition\n${setup}`, conditionalAlias),
    ).toBe(true);
    const unknown = `      - uses: actions/checkout@${sha} # v5\n        with: {path: '\${{ inputs.destination }}'}`;
    expect(fails(`${unknown}\n${trusted}\n${setup}`)).toBe(true);
    expect(fails(`${trusted}\n${setup}\n${unknown}`)).toBe(true);
    // Later ambiguous checkouts cannot reuse an unrelated tracked shadow file.
    expect(
      check(
        ".github/workflows/ci.yml",
        workflow(`${setup}\n${trusted}\n${trusted}`),
        { [`source/${target}`]: files[target] ?? "" },
      ).some((entry) => entry.rule === rule),
    ).toBe(true);
    expect(
      check(".github/workflows/ci.yml", workflow(`${trusted}\n${trusted}`)),
    ).toEqual([]);
    const distinct = `      - uses: actions/checkout@${sha} # v5\n        with: {repository: other/repository, path: unrelated}`;
    expect(fails(`${trusted}\n${setup}\n${distinct}`)).toBe(false);
    const rootSetup = setup.replace(`source/${target}`, target);
    const rootCheckout = `      - uses: actions/checkout@${sha} # v5`;
    const repeatedRoot = `${rootCheckout}\n      - uses: actions/checkout@${sha} # v5\n        with: {path: './'}\n${rootSetup}`;
    expect(fails(repeatedRoot)).toBe(true);
  }
});

test("dynamic self-repository refs delegate safe selectors without reading current pins", () => {
  for (const [tool, action, version, target] of [
    ["bun", "oven-sh/setup-bun", "v2", "package.json"],
    ["node", "actions/setup-node", "v5", ".node-version"],
    ["python", "actions/setup-python", "v6", ".python-version"],
  ]) {
    for (const repository of [
      undefined,
      "stella/example",
      "${{ github.repository }}",
      "${{ job.workflow_repository }}",
    ])
      for (const ref of [
        "${{ needs.prepare.outputs.release-ref }}",
        "${{ inputs.ref }}",
      ]) {
        const reports: unknown[] = [];
        const source = workflow(
          `      - uses: actions/checkout@${sha} # v5\n        with: {${repository === undefined ? "" : `repository: '${repository}', `}ref: '${ref}', path: source}\n      - uses: ${action}@${sha} # ${version}\n        with: {${tool}-version-file: source/${target}}`,
        );
        const diagnostics = checkRuntimeFile({
          file: ".github/workflows/ci.yml",
          text: source,
          policy,
          repository: "stella/example",
          trackedFiles: new Set(),
          readFile: () => {
            throw new Error("Delegation must not read the current source");
          },
          onDelegated: (report) => reports.push(report),
        });
        expect(diagnostics).toEqual([]);
        expect(reports).toEqual([
          {
            path: ".github/workflows/ci.yml",
            line: 7,
            tool,
            selector: `source/${target}`,
            checkoutPath: "source",
            ref,
          },
        ]);
      }
    for (const [repository, ref] of [
      ["stella/example", sha],
      ["stella/example", "main"],
      ["stella/example", "v1"],
      ["stella/example", "${{ github.sha }}"],
      ["stella/example", "${{ job.workflow_sha }}"],
      ["other/repository", "${{ inputs.ref }}"],
    ]) {
      const reports: unknown[] = [];
      const source = workflow(
        `      - uses: actions/checkout@${sha} # v5\n        with: {repository: '${repository}', ref: '${ref}', path: source}\n      - uses: ${action}@${sha} # ${version}\n        with: {${tool}-version-file: source/${target}}`,
      );
      expect(
        checkRuntimeFile({
          file: ".github/workflows/ci.yml",
          text: source,
          policy,
          repository: "stella/example",
          trackedFiles: new Set(Object.keys(files)),
          readFile: (file) => files[file],
          onDelegated: (report) => reports.push(report),
        }).length,
      ).toBeGreaterThan(0);
      expect(reports).toEqual([]);
    }
    for (const ref of [
      "${{ '" + sha + "' }}",
      "${{ 'main' }}",
      "${{ 42 }}",
      "${{ true }}",
      "${{ null }}",
      "${{ }}",
      "${{ github.sha }}",
      "${{ github['sha'] }}",
      "${{ job['workflow_sha'] }}",
      "${{ github . sha }}",
      "${{ job [ 'workflow_sha' ] }}",
      "${{ inputs.ref }}${{ inputs.other }}",
      "${{ inputs.ref }}-suffix}}",
    ]) {
      const reports: unknown[] = [];
      const text = workflow(
        `      - uses: actions/checkout@${sha} # v5\n        with: {ref: "${ref}", path: source}\n      - uses: ${action}@${sha} # ${version}\n        with: {${tool}-version-file: source/${target}}`,
      );
      expect(
        checkRuntimeFile({
          file: ".github/workflows/ci.yml",
          text,
          policy,
          trackedFiles: new Set(),
          readFile: () => undefined,
          onDelegated: (report) => reports.push(report),
        }).length,
      ).toBeGreaterThan(0);
      expect(reports).toEqual([]);
    }
    for (const formattedRef of [
      "${{ format('v{0}}}', inputs.version) }}",
      "${{ inputs.ref || '${{' }}",
    ]) {
      const formattedReports: unknown[] = [];
      expect(
        checkRuntimeFile({
          file: ".github/workflows/ci.yml",
          text: workflow(
            `      - uses: actions/checkout@${sha} # v5\n        with: {ref: "${formattedRef}", path: source}\n      - uses: ${action}@${sha} # ${version}\n        with: {${tool}-version-file: source/${target}}`,
          ),
          policy,
          trackedFiles: new Set(),
          readFile: () => {
            throw new Error("Current pin read");
          },
          onDelegated: (report) => formattedReports.push(report),
        }),
      ).toEqual([]);
      expect(formattedReports).toHaveLength(1);
    }
    const base = `      - uses: actions/checkout@${sha} # v5\n        with: {ref: '\${{ inputs.ref }}', path: source}`;
    for (const selector of [
      `source/../${target}`,
      `source/other-file`,
      `/source/${target}`,
      `source\\${target}`,
      "${{ inputs.versionFile }}",
    ]) {
      const reports: unknown[] = [];
      const text = workflow(
        `${base}\n      - uses: ${action}@${sha} # ${version}\n        with: {${tool}-version-file: '${selector}'}`,
      );
      expect(
        checkRuntimeFile({
          file: ".github/workflows/ci.yml",
          text,
          policy,
          trackedFiles: new Set(),
          readFile: () => undefined,
          onDelegated: (report) => reports.push(report),
        }).length,
      ).toBeGreaterThan(0);
      expect(reports).toEqual([]);
    }
    for (const steps of [
      `${base}\n        if: false`,
      `${base}\n        continue-on-error: false`,
      `${base}\n${base}`,
    ]) {
      const reports: unknown[] = [];
      const text = workflow(
        `${steps}\n      - uses: ${action}@${sha} # ${version}\n        with: {${tool}-version-file: source/${target}}`,
      );
      expect(
        checkRuntimeFile({
          file: ".github/workflows/ci.yml",
          text,
          policy,
          trackedFiles: new Set(),
          readFile: () => "invalid current pin",
          onDelegated: (report) => reports.push(report),
        }).length,
      ).toBeGreaterThan(0);
      expect(reports).toEqual([]);
    }
  }
});
