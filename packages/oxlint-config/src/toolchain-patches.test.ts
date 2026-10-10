import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";

import { detectToolchainChanges } from "./toolchain-changed";
import { runSelectedTypecheckParity } from "./typecheck-parity-selection";

const manifest = {
  private: true,
  packageManager: "bun@1.4.3",
  devDependencies: { typescript: "7.0.2" },
};
const bunLock = {
  lockfileVersion: 1,
  workspaces: { "": { devDependencies: { typescript: "7.0.2" } } },
  packages: { typescript: ["typescript@7.0.2"] },
};
const withPatches = async ({
  before,
  after,
  exercise,
}: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  exercise: (options: { repo: string; since: string }) => Promise<void>;
}) => {
  const repo = mkdtempSync(path.join(tmpdir(), "toolchain-patches-"));
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (files: Record<string, unknown>) => {
    for (const [file, value] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(
        path.join(repo, file),
        typeof value === "string" ? value : JSON.stringify(value),
      );
    }
  };
  const commit = () => {
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ]);
    return git(["rev-parse", "HEAD"]);
  };
  try {
    git(["init", "-q"]);
    if (Object.hasOwn(before, "pnpm-lock.yaml"))
      write({
        "package.json": {
          private: true,
          packageManager: "pnpm@12.9.1",
          devDependencies: {},
        },
        ...before,
      });
    else write({ "package.json": manifest, "bun.lock": bunLock, ...before });
    const since = commit();
    write(after);
    commit();
    await exercise({ repo, since });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
};
const changedParity = async ({
  repo,
  since,
}: {
  repo: string;
  since: string;
}) => {
  const result = await detectToolchainChanges({ repo, since });
  expect(result.status).toBe("compared");
  expect(result.tools).toContain("typescript");
  let runs = 0;
  await runSelectedTypecheckParity({
    repo,
    since,
    run: async () => {
      runs++;
      return true;
    },
    output: () => {},
  });
  expect(runs).toBe(1);
};

for (const compiler of [
  "typescript",
  "bun-types",
  "@types/bun",
  "@typescript/native",
  "@typescript/native-preview",
  "tsgo",
])
  test(`${compiler} same-version declared patch content changes run parity`, async () => {
    await withPatches({
      before: {
        "package.json": {
          ...manifest,
          patchedDependencies: {
            [`${compiler}@7.0.2`]: "config/compiler.diff",
          },
        },
        "config/compiler.diff": "compiler patch before\n",
      },
      after: { "config/compiler.diff": "compiler patch after\n" },
      exercise: changedParity,
    });
  });

for (const owner of ["manifest", "workspace"])
  test(`pnpm ${owner} compiler patch source changes run parity`, async () => {
    const patchConfig = {
      patchedDependencies: { "typescript@7.0.2": "config/compiler.diff" },
    };
    await withPatches({
      before: {
        ...(owner === "manifest"
          ? { "package.json": { ...manifest, pnpm: patchConfig } }
          : { "pnpm-workspace.yaml": stringify(patchConfig) }),
        "config/compiler.diff": "before\n",
      },
      after: { "config/compiler.diff": "after\n" },
      exercise: changedParity,
    });
  });

test("Bun lock compiler patch hashes change without changing compiler versions", async () => {
  await withPatches({
    before: {
      "bun.lock": {
        ...bunLock,
        patchedDependencies: { "typescript@7.0.2": "first-hash" },
      },
    },
    after: {
      "bun.lock": {
        ...bunLock,
        patchedDependencies: { "typescript@7.0.2": "second-hash" },
      },
    },
    exercise: changedParity,
  });
});

for (const source of ["patchedDependencies", "snapshots"])
  test(`pnpm lock ${source} compiler patch hashes change without version changes`, async () => {
    const lock = (hash: string) =>
      stringify({
        lockfileVersion: "9.0",
        importers: { ".": {} },
        packages: {},
        ...(source === "patchedDependencies"
          ? {
              patchedDependencies: {
                "typescript@7.0.2": { hash, path: "config/compiler.diff" },
              },
            }
          : { snapshots: { [`typescript@7.0.2(patch_hash=${hash})`]: {} } }),
      });
    await withPatches({
      before: {
        "pnpm-lock.yaml": lock("first"),
        "config/compiler.diff": "unchanged\n",
      },
      after: { "pnpm-lock.yaml": lock("second") },
      exercise: changedParity,
    });
  });

for (const file of [
  "patches/typescript+7.0.2.patch",
  "patches/@typescript+native+7.0.2.patch",
  "patches/@types+bun+1.4.3.patch",
  "custom/typescript+7.0.2.patch",
  "custom/parent++typescript+7.0.2.patch",
  "custom/@scope+parent++@typescript+native+7.0.2.dev.patch",
])
  test(`patch-package ${file} committed content changes run parity`, async () => {
    await withPatches({
      before: { [file]: "before\n" },
      after: { [file]: "after\n" },
      exercise: changedParity,
    });
  });

for (const declaration of ["manifest", "lock"])
  test(`compiler alias from ${declaration} recognizes custom patch-package bytes`, async () => {
    const aliasManifest = {
      ...manifest,
      devDependencies: { compiler: "npm:typescript@7.0.2" },
    };
    const aliasLock = {
      ...bunLock,
      workspaces: {
        "": { devDependencies: { compiler: "npm:typescript@7.0.2" } },
      },
      packages: { compiler: ["typescript@7.0.2"] },
    };
    await withPatches({
      before: {
        "package.json": declaration === "manifest" ? aliasManifest : manifest,
        "bun.lock":
          declaration === "manifest"
            ? aliasLock
            : {
                ...bunLock,
                packages: {
                  ...bunLock.packages,
                  compiler: ["typescript@7.0.2"],
                },
              },
        "custom/compiler+7.0.2.patch": "before\n",
      },
      after: { "custom/compiler+7.0.2.patch": "after\n" },
      exercise: changedParity,
    });
  });

test("compiler alias patch declarations retain source bytes and lock hashes", async () => {
  const aliasManifest = {
    ...manifest,
    devDependencies: { compiler: "npm:typescript@7.0.2" },
    patchedDependencies: { "compiler@7.0.2": "config/alias.diff" },
  };
  const aliasLock = {
    ...bunLock,
    workspaces: {
      "": { devDependencies: { compiler: "npm:typescript@7.0.2" } },
    },
    packages: { compiler: ["typescript@7.0.2"] },
    patchedDependencies: { "compiler@7.0.2": "first-hash" },
  };
  for (const change of ["source", "hash"])
    await withPatches({
      before: {
        "package.json": aliasManifest,
        "bun.lock": aliasLock,
        "config/alias.diff": "before\n",
      },
      after:
        change === "source"
          ? { "config/alias.diff": "after\n" }
          : {
              "bun.lock": {
                ...aliasLock,
                patchedDependencies: { "compiler@7.0.2": "second-hash" },
              },
            },
      exercise: changedParity,
    });
});

test("unrelated patch sources and hashes do not change fingerprints", async () => {
  await withPatches({
    before: {
      "package.json": {
        ...manifest,
        patchedDependencies: {
          "ordinary-library@1.0.0": "config/ordinary.diff",
        },
      },
      "bun.lock": {
        ...bunLock,
        patchedDependencies: { "ordinary-library@1.0.0": "first" },
      },
      "config/ordinary.diff": "before\n",
      "patches/ordinary-library+1.0.0.patch": "before\n",
    },
    after: {
      "bun.lock": {
        ...bunLock,
        patchedDependencies: { "ordinary-library@1.0.0": "second" },
      },
      "config/ordinary.diff": "after\n",
      "patches/ordinary-library+1.0.0.patch": "after\n",
    },
    exercise: async ({ repo, since }) => {
      expect(await detectToolchainChanges({ repo, since })).toMatchObject({
        status: "compared",
        changed: false,
        tools: [],
      });
      let runs = 0;
      await runSelectedTypecheckParity({
        repo,
        since,
        run: async () => {
          runs++;
          return true;
        },
        output: () => {},
      });
      expect(runs).toBe(0);
    },
  });
});

test("missing committed compiler patch fails closed and runs parity", async () => {
  await withPatches({
    before: { "README.md": "before\n" },
    after: {
      "package.json": {
        ...manifest,
        patchedDependencies: { "typescript@7.0.2": "config/missing.diff" },
      },
    },
    exercise: async ({ repo, since }) => {
      // A working-tree file is not a substitute for the missing committed blob.
      mkdirSync(path.join(repo, "config"));
      writeFileSync(path.join(repo, "config/missing.diff"), "untracked\n");
      expect(await detectToolchainChanges({ repo, since })).toMatchObject({
        status: "unreadable",
        changed: true,
        error: "Missing tracked compiler patch: config/missing.diff",
      });
      let runs = 0;
      await runSelectedTypecheckParity({
        repo,
        since,
        run: async () => {
          runs++;
          return true;
        },
        output: () => {},
      });
      expect(runs).toBe(1);
    },
  });
});

for (const reference of ["../compiler.diff", "/compiler.diff", ""])
  test("invalid compiler patch references fail closed", async () => {
    await withPatches({
      before: { "README.md": "before\n" },
      after: {
        "package.json": {
          ...manifest,
          patchedDependencies: { "typescript@7.0.2": reference },
        },
      },
      exercise: async ({ repo, since }) => {
        expect(await detectToolchainChanges({ repo, since })).toMatchObject({
          status: "unreadable",
          changed: true,
        });
      },
    });
  });

for (const owner of ["declaration", "patch-package"])
  test(`pnpm catalog alias ${owner} compiler patch bytes run parity`, async () => {
    const patch =
      owner === "declaration"
        ? "custom/alias.diff"
        : "custom/compiler+7.0.2.patch";
    await withPatches({
      before: {
        "package.json": {
          ...manifest,
          packageManager: "pnpm@12.9.1",
          devDependencies: { compiler: "catalog:" },
        },
        "pnpm-workspace.yaml": stringify({
          catalog: { compiler: "npm:typescript@7.0.2" },
          ...(owner === "declaration"
            ? { patchedDependencies: { "compiler@7.0.2": patch } }
            : {}),
        }),
        "pnpm-lock.yaml": stringify({
          lockfileVersion: 9,
          importers: {
            ".": {
              devDependencies: {
                compiler: {
                  specifier: "catalog:",
                  version: "typescript@7.0.2",
                },
              },
            },
          },
          packages: { "typescript@7.0.2": {} },
        }),
        [patch]: "before\n",
      },
      after: { [patch]: "after\n" },
      exercise: changedParity,
    });
  });
