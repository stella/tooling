/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import toolchain from "../toolchain.json";
import { checkToolchain } from "./toolchain-guard";
import { parseToolchainPolicy } from "./toolchain-schema";

const policy = parseToolchainPolicy(toolchain);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

type AllowlistEntry = {
  workspace: string;
  name: string;
  spec: string;
  dependency: string;
  reason: string;
};

/** Runs the real checker on a temporary Git repository built from `files`. */
const typescriptDiagnostics = (
  files: Record<string, unknown>,
  typescriptAllowlist?: readonly AllowlistEntry[],
) => {
  const root = mkdtempSync(path.join(tmpdir(), "stll-typescript-allowlist-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const tracked = {
      ...files,
      ...(typescriptAllowlist === undefined
        ? {}
        : { "stll-toolchain.json": { typescriptAllowlist } }),
    };
    for (const [file, value] of Object.entries(tracked)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), json(value));
    }
    execFileSync("git", ["add", "."], { cwd: root });
    return checkToolchain({ root, policy }).filter(
      ({ rule }) => rule === "typescript-layout" || rule === "configuration",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const nextApp: AllowlistEntry = {
  workspace: ".",
  name: "typescript",
  spec: "7.0.2",
  dependency: "next",
  reason: "next build loads typescript to read tsconfig",
};
const astroDocs: AllowlistEntry = {
  workspace: "apps/docs",
  name: "typescript",
  spec: "6.0.3",
  dependency: "@astrojs/check",
  reason: "astro check loads the TypeScript 6 language service",
};
const workspaceRoot = {
  name: "fixture",
  private: true,
  workspaces: {
    packages: ["apps/*"],
    catalogs: { ts6: { typescript: "6.0.3" } },
  },
};

test("an allowed root entry passes", () => {
  expect(
    typescriptDiagnostics(
      {
        "package.json": {
          devDependencies: { next: "16.0.0", typescript: "7.0.2" },
        },
      },
      [nextApp],
    ),
  ).toEqual([]);
});

test("an allowed workspace entry passes through its catalog", () => {
  expect(
    typescriptDiagnostics(
      {
        "package.json": workspaceRoot,
        "apps/docs/package.json": {
          devDependencies: {
            "@astrojs/check": "0.9.4",
            typescript: "catalog:ts6",
          },
        },
      },
      [astroDocs],
    ),
  ).toEqual([]);
});

test("an undeclared entry fails and shows the allowlist entry to add", () => {
  const diagnostics = typescriptDiagnostics({
    "package.json": workspaceRoot,
    "apps/docs/package.json": {
      devDependencies: { "@astrojs/check": "0.9.4", typescript: "catalog:ts6" },
    },
  });
  expect(diagnostics.map(({ rule, path: file }) => [rule, file])).toEqual([
    ["typescript-layout", "apps/docs/package.json"],
    ["typescript-layout", "package.json"],
  ]);
  const [install, catalog] = diagnostics.map(({ message }) => message);
  expect(catalog).toContain("typescriptAllowlist");
  expect(install).toContain(
    '{"workspace":"apps/docs","name":"typescript","spec":"6.0.3","dependency":"<package that needs it>","reason":"<why it needs this TypeScript>"}',
  );
  for (const replacement of ["bun check", "tsrs", "oxc-parser"])
    expect(install).toContain(replacement);
});

test("a stale entry fails when its dependency or TypeScript entry is gone", () => {
  const withoutDependency = typescriptDiagnostics(
    { "package.json": { devDependencies: { typescript: "7.0.2" } } },
    [nextApp],
  );
  expect(withoutDependency).toMatchObject([
    { rule: "typescript-layout", path: "stll-toolchain.json", line: 4 },
  ]);
  expect(withoutDependency.at(0)?.message).toBe(
    "typescriptAllowlist entry typescript 7.0.2 for . is stale: package.json no longer depends on next; remove the entry and the typescript declaration, or name the dependency that still needs it",
  );
  const withoutTypescript = typescriptDiagnostics(
    { "package.json": { devDependencies: { next: "16.0.0" } } },
    [nextApp],
  );
  expect(withoutTypescript).toMatchObject([
    {
      rule: "typescript-layout",
      path: "stll-toolchain.json",
      message:
        "typescriptAllowlist entry typescript 7.0.2 for . is stale: package.json no longer declares typescript in dependencies, devDependencies or optionalDependencies; remove the entry",
    },
  ]);
  expect(
    typescriptDiagnostics({ "package.json": workspaceRoot }, [astroDocs]),
  ).toMatchObject([
    { rule: "typescript-layout", path: "package.json" },
    {
      rule: "typescript-layout",
      path: "stll-toolchain.json",
      message:
        "typescriptAllowlist entry typescript 6.0.3 for apps/docs is stale: apps/docs/package.json is missing or invalid; remove the entry",
    },
  ]);
});

test("a spec mismatch fails, including through a catalog", () => {
  expect(
    typescriptDiagnostics(
      {
        "package.json": {
          devDependencies: { next: "16.0.0", typescript: "^7.0.2" },
        },
      },
      [nextApp],
    ),
  ).toMatchObject([
    {
      rule: "typescript-layout",
      path: "package.json",
      message:
        "typescript in package.json resolves to ^7.0.2, but typescriptAllowlist in stll-toolchain.json allows 7.0.2 for next; declare 7.0.2 or update the entry's spec",
    },
  ]);
  const drifted = typescriptDiagnostics(
    {
      "package.json": {
        ...workspaceRoot,
        workspaces: {
          ...workspaceRoot.workspaces,
          catalogs: { ts6: { typescript: "6.0.2" } },
        },
      },
      "apps/docs/package.json": {
        devDependencies: {
          "@astrojs/check": "0.9.4",
          typescript: "catalog:ts6",
        },
      },
    },
    [astroDocs],
  );
  expect(drifted.map(({ path: file }) => file).sort()).toEqual([
    "apps/docs/package.json",
    "package.json",
  ]);
  expect(
    drifted.find(({ path: file }) => file === "apps/docs/package.json")
      ?.message,
  ).toContain("resolves to 6.0.2 (from catalog:ts6)");
});

test("@typescript/native passes only with an entry", () => {
  const files = {
    "package.json": { workspaces: ["tools/*"] },
    "tools/probe/package.json": {
      devDependencies: {
        "@typescript/native": "7.0.2",
        "native-probe": "1.0.0",
      },
    },
  };
  expect(
    typescriptDiagnostics(files, [
      {
        workspace: "tools/probe",
        name: "@typescript/native",
        spec: "7.0.2",
        dependency: "native-probe",
        reason: "the probe compares native compiler output",
      },
    ]),
  ).toEqual([]);
  expect(typescriptDiagnostics(files)).toMatchObject([
    {
      rule: "typescript-layout",
      path: "tools/probe/package.json",
      message: expect.stringContaining(
        '{"workspace":"tools/probe","name":"@typescript/native","spec":"7.0.2"',
      ),
    },
  ]);
});

test("a malformed allowlist is a configuration error", () => {
  expect(
    typescriptDiagnostics({ "package.json": {} }, [
      { ...nextApp, spec: "^7.0.2" },
    ]),
  ).toMatchObject([
    {
      rule: "configuration",
      path: "stll-toolchain.json",
      message: expect.stringContaining("exact spec"),
    },
  ]);
});
