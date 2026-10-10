/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkToolchain } from "./toolchain-check";

const bunVersion = "1.4.3";
const packageJson = (properties: Record<string, unknown>) =>
  JSON.stringify(properties, null, 2);

type FixtureOptions = {
  files: Record<string, string>;
  untracked?: Record<string, string>;
  allowNonBunPackageManagers?: string[];
  deleted?: string[];
};

const checkFixture = ({
  files,
  untracked = {},
  allowNonBunPackageManagers,
  deleted = [],
}: FixtureOptions) => {
  const root = mkdtempSync(path.join(tmpdir(), "stll-toolchain-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const write = (entries: Record<string, string>) => {
      for (const [file, content] of Object.entries(entries)) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), content);
      }
    };
    write(files);
    execFileSync("git", ["add", "--", "."], { cwd: root });
    write(untracked);
    for (const file of deleted) rmSync(path.join(root, file));
    return checkToolchain({
      root,
      bunVersion,
      ...(allowNonBunPackageManagers === undefined
        ? {}
        : { allowNonBunPackageManagers }),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const cases = [
  {
    name: "package manager",
    file: "packages/app/package.json",
    pass: packageJson({ packageManager: "bun@1.4.3" }),
    fail: packageJson({ packageManager: "bun@1.4.1" }),
    message: "packageManager Bun version",
    line: 2,
  },
  {
    name: "non-Bun package manager",
    file: "package.json",
    pass: packageJson({ packageManager: "bun@1.4.3" }),
    fail: packageJson({ packageManager: "pnpm@10.0.0" }),
    message: "packageManager is not Bun",
    line: 2,
  },
  ...["dependencies", "devDependencies", "catalog"].map((key) => ({
    name: `bun-types in ${key}`,
    file: "package.json",
    pass: packageJson({ [key]: { "bun-types": "1.4.3" } }),
    fail: packageJson({ [key]: { "bun-types": "^1.4.3" } }),
    message: "bun-types",
    line: 3,
  })),
  {
    name: "bun-types in named catalogs",
    file: "package.json",
    pass: packageJson({ catalogs: { tooling: { "bun-types": "1.4.3" } } }),
    fail: packageJson({ catalogs: { tooling: { "bun-types": "1.4.1" } } }),
    message: "bun-types",
    line: 4,
  },
  ...[
    ".github/workflows/ci.yml",
    ".github/workflows/ci.yaml",
    ".github/actions/setup/nested/action.yml",
    ".github/actions/setup/action.yaml",
  ].map((file) => ({
    name: `workflow pin in ${file}`,
    file,
    pass: "with:\n  bun-version-file: package.json\n",
    fail: "with:\n  bun-version: 1.4.3\n",
    message: "bun-version literals",
    line: 2,
  })),
  ...["Dockerfile", "docker/Dockerfile.test", "Containerfile"].map((file) => ({
    name: `image pin in ${file}`,
    file,
    pass: "# image\nFROM --platform=linux/amd64 oven/bun:1.4.3-alpine@sha256:abc AS app\n",
    fail: "# image\nFROM oven/bun:1.4.1-alpine@sha256:abc AS app\n",
    message: "oven/bun version",
    line: 2,
  })),
  {
    name: "Bun version file",
    file: ".bun-version",
    pass: "1.4.3\n",
    fail: "1.4.1\n",
    message: ".bun-version",
    line: 1,
  },
  {
    name: "asdf Bun entry",
    file: ".tool-versions",
    pass: "nodejs 22.0.0\nbun 1.4.3\n",
    fail: "nodejs 22.0.0\nbun 1.4.1\n",
    message: ".tool-versions Bun version",
    line: 2,
  },
  ...["mise.toml", ".mise.toml"].map((file) => ({
    name: `mise Bun entry in ${file}`,
    file,
    pass: "[tools]\nbun = '1.4.3' # pinned\n",
    fail: "[tools]\nbun = '1.4.1'\n",
    message: "mise Bun version",
    line: 2,
  })),
  {
    name: "mise dotted Bun key",
    file: "mise.toml",
    pass: 'tools.bun = "1.4.3"\n',
    fail: 'tools.bun = "latest"\n',
    message: "mise Bun version",
    line: 1,
  },
];

describe("consumer toolchain guard", () => {
  test("CLI returns success, diagnostic failure, help, and argument failure", () => {
    const root = mkdtempSync(path.join(tmpdir(), "stll-toolchain-cli-"));
    const entry = path.resolve(import.meta.dir, "toolchain-check-cli.ts");
    try {
      execFileSync("git", ["init", "-q", root]);
      writeFileSync(
        path.join(root, "package.json"),
        packageJson({ packageManager: "bun@1.4.3" }),
      );
      execFileSync("git", ["add", "package.json"], { cwd: root });
      const run = (args: string[]) =>
        spawnSync(process.execPath, [entry, ...args], {
          cwd: root,
          encoding: "utf8",
        });
      const passing = run([]);
      expect(passing.status).toBe(0);
      expect(passing.stderr).toBe("");
      writeFileSync(
        path.join(root, "package.json"),
        packageJson({ packageManager: "bun@1.4.1" }),
      );
      const failing = run([]);
      expect(failing.status).toBe(1);
      expect(failing.stderr).toContain(
        "package.json:2: packageManager Bun version must be 1.4.3",
      );
      const help = run(["--help"]);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("Usage: stll-toolchain-check");
      for (const args of [["--unknown"], ["--allow-non-bun-package-manager"]]) {
        const invalid = run(args);
        expect(invalid.status).toBe(1);
        expect(invalid.stderr).toContain(
          "toolchain-check:1: unexpected or incomplete argument",
        );
      }
      writeFileSync(
        path.join(root, "package.json"),
        packageJson({ packageManager: "npm@10.0.0" }),
      );
      expect(
        run(["--allow-non-bun-package-manager", "package.json"]).status,
      ).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  for (const fixture of cases) {
    test(fixture.name, () => {
      const base = {
        "package.json": packageJson({ packageManager: "bun@1.4.3" }),
      };
      expect(
        checkFixture({ files: { ...base, [fixture.file]: fixture.pass } }),
      ).toEqual([]);
      const diagnostics = checkFixture({
        files: { ...base, [fixture.file]: fixture.fail },
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics).toEqual([
        {
          path: fixture.file,
          line: fixture.line,
          message: expect.stringContaining(fixture.message),
        },
      ]);
    });
  }

  test("non-Bun exceptions apply only to their explicit package path", () => {
    expect(
      checkFixture({
        files: {
          "package.json": packageJson({ packageManager: "pnpm@10.0.0" }),
          "packages/other/package.json": packageJson({
            packageManager: "npm@10.0.0",
          }),
        },
        allowNonBunPackageManagers: ["package.json"],
      }),
    ).toEqual([
      {
        path: "packages/other/package.json",
        line: 2,
        message: expect.stringContaining("not Bun"),
      },
    ]);
  });

  test("resolves default and named catalog references", () => {
    expect(
      checkFixture({
        files: {
          "package.json": packageJson({
            dependencies: { "bun-types": "catalog:" },
            devDependencies: { "bun-types": "catalog:types" },
            catalog: { "bun-types": "1.4.3" },
            catalogs: { types: { "bun-types": "1.4.3" } },
          }),
        },
      }),
    ).toEqual([]);
    expect(
      checkFixture({
        files: {
          "package.json": packageJson({
            dependencies: { "bun-types": "catalog:missing" },
          }),
        },
      }),
    ).toEqual([
      {
        path: "package.json",
        line: 3,
        message: expect.stringContaining("bun-types must be"),
      },
    ]);
  });

  test("resolves workspace root catalogs for child packages", () => {
    expect(
      checkFixture({
        files: {
          "package.json": packageJson({
            workspaces: {
              packages: ["packages/*"],
              catalog: { "bun-types": "1.4.3" },
              catalogs: { named: { "bun-types": "1.4.3" } },
            },
          }),
          "packages/app/package.json": packageJson({
            dependencies: { "bun-types": "catalog:" },
            devDependencies: { "bun-types": "catalog:named" },
          }),
        },
      }),
    ).toEqual([]);
    expect(
      checkFixture({
        files: {
          "package.json": packageJson({
            workspaces: { catalog: { "bun-types": "1.4.1" } },
          }),
        },
      }),
    ).toEqual([
      {
        path: "package.json",
        line: 4,
        message: expect.stringContaining("bun-types must be"),
      },
    ]);
  });

  test("reports the line of each divergent repeated dependency key", () => {
    expect(
      checkFixture({
        files: {
          "package.json": packageJson({
            dependencies: { "bun-types": "1.4.3" },
            devDependencies: { "bun-types": "1.4.1" },
            catalog: { "bun-types": "1.4.2" },
          }),
        },
      }),
    ).toEqual([
      {
        path: "package.json",
        line: 6,
        message: expect.stringContaining("found 1.4.1"),
      },
      {
        path: "package.json",
        line: 9,
        message: expect.stringContaining("found 1.4.2"),
      },
    ]);
  });

  test("reports distinct lines for repeated identical divergent versions", () => {
    expect(
      checkFixture({
        files: {
          "package.json": packageJson({
            dependencies: { "bun-types": "1.4.1" },
            devDependencies: { "bun-types": "1.4.1" },
          }),
        },
      }),
    ).toEqual([
      {
        path: "package.json",
        line: 3,
        message: expect.stringContaining("found 1.4.1"),
      },
      {
        path: "package.json",
        line: 6,
        message: expect.stringContaining("found 1.4.1"),
      },
    ]);
  });

  test("checks inline YAML Bun literals", () => {
    expect(
      checkFixture({
        files: { ".github/workflows/ci.yml": "with: { bun-version: 1.4.3 }\n" },
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 1,
        message: expect.stringContaining("bun-version literals"),
      },
    ]);
  });

  test("validates inline YAML bun-version-file targets", () => {
    expect(
      checkFixture({
        files: {
          "package.json": packageJson({ packageManager: "bun@1.4.3" }),
          ".github/workflows/ci.yml":
            'with: { bun-version-file: "package.json" }\n',
        },
      }),
    ).toEqual([]);
    expect(
      checkFixture({
        files: {
          ".github/workflows/ci.yml":
            "with: { bun-version-file: missing.json }\n",
        },
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 1,
        message: expect.stringContaining("must reference"),
      },
    ]);
  });

  for (const [pass, fail] of [
    [
      '[tools]\nbun = { version = "1.4.3", os = "linux" }\n',
      '[tools]\nbun = { version = "1.4.1" }\n',
    ],
    ['[tools.bun]\nversion = "1.4.3"\n', '[tools.bun]\nversion = "latest"\n'],
  ]) {
    test(`checks mise Bun table ${pass}`, () => {
      expect(checkFixture({ files: { "mise.toml": pass ?? "" } })).toEqual([]);
      expect(checkFixture({ files: { "mise.toml": fail ?? "" } })).toEqual([
        {
          path: "mise.toml",
          line: 2,
          message: expect.stringContaining("mise Bun version"),
        },
      ]);
    });
  }

  for (const file of ["mise.toml", ".mise.toml"]) {
    for (const prefix of [
      "[tools]\nbun = ",
      "tools.bun = ",
      "tools = { bun = ",
    ]) {
      const wrap = (table: string) =>
        `${prefix}${table}${prefix.startsWith("tools =") ? " }" : ""}\n`;
      test(`checks version after another mise inline-table field in ${file} ${prefix}`, () => {
        expect(
          checkFixture({
            files: { [file]: wrap('{ os = "linux", version = "1.4.3" }') },
          }),
        ).toEqual([]);
        expect(
          checkFixture({
            files: { [file]: wrap('{ os = "linux", version = "1.4.1" }') },
          }),
        ).toEqual([
          {
            path: file,
            line: prefix.startsWith("[tools]") ? 2 : 1,
            message: expect.stringContaining(
              "mise Bun version must be 1.4.3, found 1.4.1",
            ),
          },
        ]);
        expect(
          checkFixture({ files: { [file]: wrap('{ os = "linux" }') } }),
        ).toEqual([
          {
            path: file,
            line: prefix.startsWith("[tools]") ? 2 : 1,
            message: expect.stringContaining("mise Bun version must be"),
          },
        ]);
      });
    }
  }

  test("checks inline mise tools", () => {
    expect(
      checkFixture({
        files: { "mise.toml": "tools = { bun = '1.4.3', node = '22' }\n" },
      }),
    ).toEqual([]);
    expect(
      checkFixture({ files: { "mise.toml": "tools = { bun = '1.4.1' }\n" } }),
    ).toEqual([
      {
        path: "mise.toml",
        line: 1,
        message: expect.stringContaining("mise Bun version"),
      },
    ]);
  });

  test("ignores untracked files, dependencies, vendor files and commented pins", () => {
    expect(
      checkFixture({
        files: {
          "package.json": "{}",
          "node_modules/nested/package.json": packageJson({
            packageManager: "bun@0.0.0",
          }),
          "vendor/package.json": packageJson({
            devDependencies: { "bun-types": "0.0.0" },
          }),
          ".github/workflows/ci.yml": "# bun-version: 0.0.0\n",
          Dockerfile: "# FROM oven/bun:0.0.0\nFROM oven/bun@sha256:abc\n",
        },
        untracked: { ".bun-version": "0.0.0\n" },
      }),
    ).toEqual([]);
  });

  for (const [name, target, pkg] of [
    ["missing", "missing/package.json", undefined],
    ["wrong manager", "package.json", { packageManager: "bun@1.4.1" }],
    ["absent manager", "package.json", {}],
    ["wrong file kind", ".bun-version", undefined],
    ["dynamic target", "${{ inputs.version_file }}", undefined],
    ["outside repository", "../package.json", undefined],
    ["absolute target", "/package.json", undefined],
  ] satisfies [string, string, Record<string, unknown> | undefined][]) {
    test(`rejects ${name} bun-version-file target`, () => {
      const diagnostics = checkFixture({
        files: {
          "package.json": packageJson(pkg ?? { packageManager: "bun@1.4.3" }),
          ".github/workflows/ci.yml": `with:\n  bun-version-file: ${target}\n`,
        },
      });
      expect(diagnostics).toContainEqual({
        path: ".github/workflows/ci.yml",
        line: 2,
        message: expect.stringContaining(
          "must reference a tracked package.json",
        ),
      });
    });
  }

  test("accepts normalized quoted workflow target", () => {
    expect(
      checkFixture({
        files: {
          "package.json": packageJson({ packageManager: "bun@1.4.3" }),
          ".github/workflows/ci.yml":
            'with:\n  bun-version-file: "./package.json" # source\n',
        },
      }),
    ).toEqual([]);
  });

  test("invalid package JSON fails instead of skipping its pins", () => {
    expect(checkFixture({ files: { "package.json": "{" } })).toEqual([
      { path: "package.json", line: 1, message: "invalid package.json" },
    ]);
  });

  test("nonobject package JSON fails", () => {
    expect(checkFixture({ files: { "package.json": "[]" } })).toEqual([
      {
        path: "package.json",
        line: 1,
        message: "package.json must contain an object",
      },
    ]);
  });

  test("tracked missing configuration fails instead of skipping its pins", () => {
    expect(
      checkFixture({
        files: { ".bun-version": "1.4.3" },
        deleted: [".bun-version"],
      }),
    ).toEqual([
      { path: ".bun-version", line: 1, message: "cannot read tracked file" },
    ]);
  });

  test("empty and commented-only .bun-version files fail", () => {
    for (const content of ["", "# 1.4.3\n"])
      expect(checkFixture({ files: { ".bun-version": content } })).toEqual([
        {
          path: ".bun-version",
          line: 1,
          message: expect.stringContaining("must be"),
        },
      ]);
  });

  test("mutable image tags and untagged images fail", () => {
    const diagnostics = checkFixture({
      files: { Dockerfile: "FROM oven/bun:latest\nFROM oven/bun\n" },
    });
    expect(diagnostics).toHaveLength(2);
  });
});
