/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareRepository,
  discoverConfigGroups,
  discoverProjectGraphs,
  resolveCompiler,
} from "./typecheck-parity";
import { parseParityArguments } from "./typecheck-parity-args";

const policy = {
  typescriptInstallLayouts: [
    {
      type: "split-compatibility",
      compilerPackage: "@typescript/native",
      compilerSpecifier: "npm:typescript@7.0.2",
    },
  ],
};

const withRepository = async (
  run: (root: string, compiler: string) => Promise<void>,
) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "parity-projects-")),
  );
  try {
    const compiler = join(root, "node_modules/@typescript/native/bin/tsc.js");
    await mkdir(dirname(compiler), { recursive: true });
    await writeFile(
      join(dirname(dirname(compiler)), "package.json"),
      JSON.stringify({
        name: "@typescript/native",
        version: "7.0.2",
        bin: { tsc: "bin/tsc.js" },
      }),
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        devDependencies: {
          "@typescript/native": "npm:typescript@7.0.2",
          typescript: "6.0.3",
        },
      }),
    );
    await writeFile(
      compiler,
      `const fs = require('node:fs');
const path = process.argv[process.argv.indexOf('--project') + 1];
const config = JSON.parse(fs.readFileSync(path, 'utf8'));
if (process.argv.includes('--showConfig')) console.log(JSON.stringify(config));
else fs.writeFileSync(${JSON.stringify(join(root, "checked.json"))}, JSON.stringify(config));`,
    );
    await run(root, compiler);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const writeProject = async (root: string, name: string, config: unknown) => {
  const path = join(root, name, "tsconfig.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config));
  await writeFile(join(dirname(path), "input.ts"), "export const input = 1;");
  await writeFile(join(dirname(path), "package.json"), "{}");
  return path;
};

test("repeatable projects select only named configs in a monorepo without a root config", async () => {
  await withRepository(async (root, compiler) => {
    const first = await writeProject(root, "packages/first", {
      compilerOptions: { strict: true },
      files: ["input.ts"],
      references: [{ path: "../unselected", prepend: true }],
    });
    const second = await writeProject(root, "packages/second", {
      compilerOptions: {},
      files: ["input.ts"],
    });
    const unselected = await writeProject(root, "packages/unselected", {
      files: [],
    });
    const args = parseParityArguments([
      "--project",
      "packages/first/tsconfig.json",
      "--project",
      "packages/second",
    ]);
    expect(args.mode).toBe("selected");
    if (args.mode !== "selected") throw new Error("Expected selected projects");
    expect(await resolveCompiler(root, policy)).toBe(compiler);
    const graphs = discoverProjectGraphs({
      repo: root,
      compiler,
      projects: [...args.projects, "packages/first"],
    });
    expect(graphs.map((graph) => graph.root)).toEqual([first, second]);
    expect(
      graphs.flatMap((graph) => graph.projects.map((project) => project.path)),
    ).toEqual([first, second]);
    expect(graphs.every((graph) => !graph.build)).toBe(true);
    expect(graphs.at(0)?.projects.at(0)?.resolvedReferences).toEqual([
      { path: unselected, prepend: true },
    ]);
    const bun = join(root, "fake-bun");
    await writeFile(bun, "#!/bin/sh\nexit 0\n");
    await chmod(bun, 0o755);
    const graph = graphs.at(0);
    if (graph === undefined) throw new Error("Missing selected graph");
    expect(
      (await compareRepository({ repo: root, compiler, bun, graph })).repository
        .passed,
    ).toBe(true);
    const checked: unknown = JSON.parse(
      await readFile(join(root, "checked.json"), "utf8"),
    );
    expect(checked).toMatchObject({
      references: [{ path: unselected, prepend: true }],
    });
  });
});

test("default mode traverses references from a zero-input solution root", async () => {
  await withRepository(async (root, compiler) => {
    const child = await writeProject(root, "packages/child", {
      files: ["input.ts"],
    });
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ files: [], references: [{ path: "packages/child" }] }),
    );
    const graph = discoverConfigGroups({ repo: root, compiler });
    expect(graph.build).toBe(true);
    expect(graph.projects.map((project) => project.path)).toEqual([
      join(root, "tsconfig.json"),
      child,
    ]);
    expect(graph.groups.flatMap((group) => group.projects)).toEqual([child]);
    expect(() =>
      discoverConfigGroups({ repo: root, compiler, project: "tsconfig.json" }),
    ).toThrow("zero input files");
  });
});

test("missing, unreadable and invalid selected configs fail closed", async () => {
  await withRepository(async (root, compiler) => {
    const empty = await writeProject(root, "empty", { files: [] });
    const malformed = await writeProject(root, "malformed", {
      files: "input.ts",
    });
    const unreadable = join(root, "unreadable/tsconfig.json");
    await mkdir(unreadable, { recursive: true });
    for (const project of ["missing.json", empty, malformed, unreadable])
      expect(() =>
        discoverConfigGroups({ repo: root, compiler, project }),
      ).toThrow();
  });
});

test("help succeeds without a repository; unknown or incomplete arguments fail", async () => {
  await withRepository(async (root) => {
    const empty = join(root, "empty");
    await mkdir(empty);
    const cli = fileURLToPath(
      new URL("./typecheck-parity-cli.ts", import.meta.url),
    );
    const help = spawnSync(process.execPath, [cli, "--help"], {
      cwd: empty,
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--project <tsconfig>");
    expect(help.stderr).toBe("");
    for (const args of [
      ["--unknown"],
      ["--project"],
      ["--project", "--help"],
      ["--help", "--unknown"],
    ]) {
      expect(() => parseParityArguments(args)).toThrow("Usage:");
      expect(
        spawnSync(process.execPath, [cli, ...args], {
          cwd: empty,
          encoding: "utf8",
        }).status,
      ).toBe(1);
    }
    expect(parseParityArguments([])).toEqual({ mode: "default" });
  });
});

// Full seeded comparisons launch real compilers and belong to CI.
test.skipIf(process.env["CI"] !== "true")(
  "real CLI checks two child configs using only the root compiler installation",
  async () => {
    const installation = fileURLToPath(new URL("../../../", import.meta.url));
    const consumer = await realpath(
      await mkdtemp(join(tmpdir(), "parity-selected-cli-")),
    );
    try {
      await symlink(
        join(installation, "node_modules"),
        join(consumer, "node_modules"),
        "dir",
      );
      await writeFile(
        join(consumer, "package.json"),
        JSON.stringify({ devDependencies: { typescript: "7.0.2" } }),
      );
      for (const name of ["first", "second"])
        await writeProject(consumer, name, {
          compilerOptions: {
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "Bundler",
            types: [],
          },
          files: ["input.ts"],
        });
      await writeProject(consumer, "unselected", { files: [] });
      const cli = fileURLToPath(
        new URL("./typecheck-parity-cli.ts", import.meta.url),
      );
      const result = spawnSync(
        process.execPath,
        [
          cli,
          "--project",
          "first/tsconfig.json",
          "--project",
          "second/tsconfig.json",
        ],
        {
          cwd: consumer,
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("first/tsconfig.json");
      expect(result.stdout).toContain("second/tsconfig.json");
      expect(result.stdout).not.toContain("unselected/tsconfig.json");
      expect(result.stdout.match(/repository tsc:/g)).toHaveLength(2);
    } finally {
      await rm(consumer, { recursive: true, force: true });
    }
  },
  130_000,
);
