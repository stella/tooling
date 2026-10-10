/// <reference types="bun-types" />
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import toolchain from "../toolchain.json";
import {
  checkToolchain,
  parseToolchainOptOuts,
  toolchainRules,
} from "./toolchain-guard";
import { toolchainInputKind } from "./toolchain-inputs";
import { packagePinKeys, parseToolchainPolicy } from "./toolchain-schema";

const policy = parseToolchainPolicy(toolchain);
const fixture = (
  files: Record<string, string>,
  untracked: Record<string, string> = {},
) => {
  const root = mkdtempSync(path.join(tmpdir(), "stll-shared-toolchain-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const write = (entries: Record<string, string>) => {
      for (const [file, text] of Object.entries(entries)) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), text);
      }
    };
    write(files);
    execFileSync("git", ["add", "."], { cwd: root });
    write(untracked);
    return checkToolchain({ root, policy });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("empty repositories do not acquire unrelated tool requirements", () => {
  expect(fixture({ "readme.txt": "hello" })).toEqual([]);
});

test("tracked root and nested action metadata cannot bypass snapshot discovery", () => {
  const config = JSON.stringify({
    optOuts: [{ rule: "dependabot-policy", reason: "Action metadata fixture" }],
  });
  for (const file of [
    "action.yml",
    "action.yaml",
    "tools/build/action.yml",
    "tools/deep/build/action.yaml",
  ]) {
    expect(
      fixture({
        [file]:
          "runs: {using: composite, steps: [{uses: 'actions/checkout@main'}]}",
        "stll-toolchain.json": config,
      }).some(({ rule, path }) => rule === "action-pins" && path === file),
    ).toBe(true);
    expect(
      fixture(
        { "stll-toolchain.json": config },
        {
          [file]:
            "runs: {using: composite, steps: [{uses: 'actions/checkout@main'}]}",
        },
      ),
    ).toEqual([]);
  }
});

test("mise environment overrides remain part of the tracked configuration snapshot", () => {
  for (const file of [
    "mise.ci.toml",
    ".mise.production.toml",
    "tools/mise.ci.local.toml",
    ".config/mise/config.ci.toml",
    "mise/conf.d/node.toml",
  ])
    expect(
      fixture({ [file]: "[tools]\nnode = 'latest'" }).some(
        ({ rule, path }) => rule === "runtime-manager" && path === file,
      ),
    ).toBe(true);
});

test("configuration discovery shares lockfile presence without parsing lock contents", () => {
  for (const file of ["bun.lock", "uv.lock", "tools/bun.lock", "tools/uv.lock"])
    expect(toolchainInputKind(file)).toBe("presence");
  for (const file of [
    "action.yml",
    "tools/action.yaml",
    ".github/workflows/ci.yml",
    "package.json",
    ".node-version",
  ])
    expect(toolchainInputKind(file)).toBe("config");
  for (const file of ["source.ts", "example/bun.lock.txt", "uv.lock.backup"])
    expect(toolchainInputKind(file)).toBeUndefined();
  expect(
    fixture({
      "bun.lock": "invalid opaque content",
      "uv.lock": "invalid opaque content",
      "stll-toolchain.json": JSON.stringify({
        optOuts: [
          { rule: "dependabot-policy", reason: "Lockfile presence fixture" },
        ],
      }),
    }),
  ).toEqual([]);
});

test("Docker action policy opt-outs require a tracked explicit reason", () => {
  const action =
    "runs: {using: composite, steps: [{uses: 'docker://alpine:3'}]}";
  const base = {
    "action.yml": action,
    "stll-toolchain.json": JSON.stringify({
      optOuts: [{ rule: "dependabot-policy", reason: "Action fixture" }],
    }),
  };
  expect(fixture(base).some(({ rule }) => rule === "action-pins")).toBe(true);
  expect(
    fixture({
      ...base,
      "stll-toolchain.json": JSON.stringify({
        optOuts: [
          { rule: "dependabot-policy", reason: "Action fixture" },
          {
            rule: "action-pins",
            reason: "Repository maintains Docker image action digest policy",
          },
        ],
      }),
    }),
  ).toEqual([]);
});

test("every named rule has a reasoned tracked opt-out and malformed choices fail", () => {
  expect(new Set(toolchainRules).size).toBe(toolchainRules.length);
  for (const rule of toolchainRules) {
    expect(
      parseToolchainOptOuts({
        optOuts: [{ rule, reason: "Explicit repository decision" }],
      }).has(rule),
    ).toBe(true);
    expect(() =>
      parseToolchainOptOuts({ optOuts: [{ rule, reason: " " }] }),
    ).toThrow();
  }
  for (const input of [
    { optOuts: [{ rule: "typo", reason: "reason" }] },
    { optOuts: true },
    { optOuts: [], skip: true },
    { optOuts: [{ rule: "bun-pins", reason: "a", path: "any" }] },
    {
      optOuts: [
        { rule: "bun-pins", reason: "a" },
        { rule: "bun-pins", reason: "b" },
      ],
    },
  ])
    expect(() => parseToolchainOptOuts(input)).toThrow();
});

test("untracked and invalid opt-outs cannot conceal a failing runtime", () => {
  const failing = { ".node-version": "0.0.0\n" };
  const config = JSON.stringify({
    optOuts: [{ rule: "node-version", reason: "Separate runtime requirement" }],
  });
  expect(fixture({ ...failing, "stll-toolchain.json": config })).toEqual([]);
  expect(
    fixture(failing, { "stll-toolchain.json": config }).map(
      (entry) => entry.rule,
    ),
  ).toEqual(["node-version"]);
  expect(
    fixture({ ...failing, "stll-toolchain.json": "{}" }).map(
      (entry) => entry.rule,
    ),
  ).toEqual(["configuration", "node-version"]);
});

test("policy rejects schema drift, missing pins, inconsistent TS layouts and invalid SHAs", () => {
  expect(policy.packages).toEqual(
    Object.fromEntries(packagePinKeys.map((key) => [key, toolchain[key]])),
  );
  for (const key of [
    ...packagePinKeys,
    "bun",
    "typescript",
    "node",
    "python",
    "rust",
    "rustCompilerDevelopment",
  ])
    expect(() => parseToolchainPolicy({ ...toolchain, [key]: null })).toThrow();
  for (const key of packagePinKeys)
    expect(() =>
      parseToolchainPolicy({ ...toolchain, [key]: "^1.2.3" }),
    ).toThrow();
  expect(() =>
    parseToolchainPolicy({ ...toolchain, schemaVersion: 2 }),
  ).toThrow();
  expect(() =>
    parseToolchainPolicy({ ...toolchain, typescript: "0.0.0" }),
  ).toThrow();
  expect(() =>
    parseToolchainPolicy({
      ...toolchain,
      actions: { checkout: { sha: "main", version: "v1" } },
    }),
  ).toThrow();
  expect(() =>
    parseToolchainPolicy({
      ...toolchain,
      dependabot: { ...toolchain.dependabot, cooldown: { defaultDays: 0 } },
    }),
  ).toThrow();
});

test("all package and runtime diagnostics survive orchestration and only named rules opt out", () => {
  const files = {
    "package.json": JSON.stringify({
      devDependencies: { oxlint: "latest" },
      packageManager: `bun@${policy.bun}`,
    }),
    ".node-version": "0.0.0",
    "stll-toolchain.json": JSON.stringify({
      optOuts: [{ rule: "dependabot-policy", reason: "Dependency fixture" }],
    }),
  };
  expect(fixture(files).map((entry) => entry.rule)).toEqual([
    "package-pins",
    "node-version",
  ]);
  expect(
    fixture({
      ...files,
      "stll-toolchain.json": JSON.stringify({
        optOuts: [
          { rule: "dependabot-policy", reason: "Dependency fixture" },
          { rule: "node-version", reason: "Separate runtime" },
        ],
      }),
    }).map((entry) => entry.rule),
  ).toEqual(["package-pins"]);
});
