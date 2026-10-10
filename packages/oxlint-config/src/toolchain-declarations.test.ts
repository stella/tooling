import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";

import { detectToolchainChanges } from "./toolchain-changed";
import { runSelectedTypecheckParity } from "./typecheck-parity-selection";

const bunAction = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";
const workflow = (inputs: Record<string, string>) => ({
  on: { pull_request: {} },
  jobs: {
    check: {
      "runs-on": "ubuntu-latest",
      steps: [{ uses: bunAction, with: inputs }],
    },
  },
});
const nestedCatalogManifest = (catalogs: Record<string, unknown>) => ({
  private: true,
  packageManager: "bun@1.4.3",
  devDependencies: { typescript: "7.0.2" },
  workspaces: {
    packages: ["packages/*", "!packages/excluded"],
    ...catalogs,
  },
});
const compiler = (version: string) => ({
  name: "excluded-compiler",
  private: true,
  devDependencies: { typescript: version },
});

type DeclarationMutation = {
  name: string;
  base?: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};
const mutations = [
  {
    name: "workflow-only Bun literal bump",
    before: {
      ".github/workflows/check.yml": workflow({ "bun-version": "1.4.2" }),
    },
    after: {
      ".github/workflows/check.yml": workflow({ "bun-version": "1.4.3" }),
    },
  },
  {
    name: "Bun version-file selector path changes with equal file contents",
    before: {
      ".github/workflows/check.yml": workflow({
        "bun-version-file": "config/runtime-current.txt",
      }),
      "config/runtime-current.txt": "1.4.3\n",
      "config/runtime-next.txt": "1.4.3\n",
    },
    after: {
      ".github/workflows/check.yml": workflow({
        "bun-version-file": "config/runtime-next.txt",
      }),
    },
  },
  {
    name: "Bun version-file content bump at an arbitrary tracked path",
    before: {
      ".github/workflows/check.yml": workflow({
        "bun-version-file": "config/runtime-selected.txt",
      }),
      "config/runtime-selected.txt": "1.4.2\n",
    },
    after: { "config/runtime-selected.txt": "1.4.3\n" },
  },
  {
    name: "Bun manifest file-selector content bump",
    before: {
      ".github/workflows/check.yml": workflow({
        "bun-version-file": "config/runtime-package.json",
      }),
      "config/runtime-package.json": {
        private: true,
        packageManager: "bun@1.4.2",
      },
    },
    after: {
      "config/runtime-package.json": {
        private: true,
        packageManager: "bun@1.4.3",
      },
    },
  },
  {
    name: "composite setup action SHA change with unchanged Bun selector",
    before: {
      ".github/actions/runtime/action.yml": {
        name: "Runtime",
        description: "Install runtime",
        runs: {
          using: "composite",
          steps: [{ uses: bunAction, with: { "bun-version": "1.4.3" } }],
        },
      },
    },
    after: {
      ".github/actions/runtime/action.yml": {
        name: "Runtime",
        description: "Install runtime",
        runs: {
          using: "composite",
          steps: [
            {
              uses: `oven-sh/setup-bun@${"1".repeat(40)}`,
              with: { "bun-version": "1.4.3" },
            },
          ],
        },
      },
    },
  },
  {
    name: "Docker ARG-backed Bun version bump",
    before: {
      Dockerfile: "ARG BUN_VERSION=1.4.2\nFROM oven/bun:${BUN_VERSION}\n",
    },
    after: {
      Dockerfile: "ARG BUN_VERSION=1.4.3\nFROM oven/bun:${BUN_VERSION}\n",
    },
  },
  {
    name: "excluded standalone package compiler declaration bump",
    before: { "packages/excluded/package.json": compiler("7.0.2") },
    after: { "packages/excluded/package.json": compiler("6.0.3") },
  },
  {
    name: "default TypeScript catalog declaration bump without lock changes",
    before: {
      "pnpm-workspace.yaml":
        "packages: [packages/*]\ncatalog:\n  typescript: 7.0.2\n",
    },
    after: {
      "pnpm-workspace.yaml":
        "packages: [packages/*]\ncatalog:\n  typescript: 6.0.3\n",
    },
  },
  {
    name: "named TypeScript catalog declaration bump without lock changes",
    before: {
      "pnpm-workspace.yaml":
        "packages: [packages/*]\ncatalogs:\n  compiler:\n    typescript: 7.0.2\n",
    },
    after: {
      "pnpm-workspace.yaml":
        "packages: [packages/*]\ncatalogs:\n  compiler:\n    typescript: 6.0.3\n",
    },
  },
  {
    name: "excluded standalone unversioned npm compiler alias changes",
    before: {
      "packages/excluded/package.json": {
        private: true,
        devDependencies: { compiler: "npm:typescript" },
      },
    },
    after: {
      "packages/excluded/package.json": {
        private: true,
        devDependencies: { compiler: "npm:@typescript/native" },
      },
    },
  },
  {
    name: "nested Bun workspaces default TypeScript catalog changes",
    before: {
      "package.json": nestedCatalogManifest({
        catalog: { typescript: "7.0.2" },
      }),
    },
    after: {
      "package.json": nestedCatalogManifest({
        catalog: { typescript: "7.0.3" },
      }),
    },
  },
  {
    name: "nested Bun workspaces named compiler alias catalog changes",
    before: {
      "package.json": nestedCatalogManifest({
        catalogs: { build: { compiler: "npm:typescript@7.0.2" } },
      }),
    },
    after: {
      "package.json": nestedCatalogManifest({
        catalogs: { build: { compiler: "npm:typescript@7.0.3" } },
      }),
    },
  },
] as const satisfies readonly DeclarationMutation[];

const withSnapshots = async (
  mutation: DeclarationMutation,
  exercise: (options: { repo: string; since: string }) => Promise<void>,
) => {
  const repo = mkdtempSync(path.join(tmpdir(), "toolchain-declarations-"));
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
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "fixture",
    ]);
    return git(["rev-parse", "HEAD"]);
  };
  try {
    git(["init", "-q"]);
    write(
      mutation.base ?? {
        "package.json": {
          private: true,
          packageManager: "bun@1.4.3",
          workspaces: ["packages/*", "!packages/excluded"],
          devDependencies: { typescript: "7.0.2" },
        },
        "bun.lock": {
          lockfileVersion: 1,
          workspaces: { "": { devDependencies: { typescript: "7.0.2" } } },
          packages: { typescript: ["typescript@7.0.2"] },
        },
      },
    );
    write(mutation.before);
    const since = commit();
    write(mutation.after);
    commit();
    await exercise({ repo, since });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
};

for (const mutation of mutations)
  test(`${mutation.name} forces compiler parity from committed declarations`, async () => {
    await withSnapshots(mutation, async ({ repo, since }) => {
      const unchanged = await detectToolchainChanges({ repo, since: "HEAD" });
      expect(unchanged.status).toBe("compared");
      expect(unchanged.changed).toBe(false);
      const result = await detectToolchainChanges({ repo, since });
      expect(result.status).toBe("compared");
      expect(result.changed).toBe(true);
      expect(
        result.tools.some((tool) => tool === "bun" || tool === "typescript"),
      ).toBe(true);
      let invocations = 0;
      const passed = await runSelectedTypecheckParity({
        repo,
        since,
        run: async () => {
          invocations++;
          return false;
        },
        output: () => {
          throw new Error("changed compiler declarations must not skip parity");
        },
      });
      expect(invocations).toBe(1);
      expect(passed).toBe(false);
    });
  });

test("unclassifiable changed runtime declarations run parity rather than skipping", async () => {
  await withSnapshots(
    {
      name: "dynamic runtime selector",
      before: {
        ".github/workflows/check.yml": workflow({
          "bun-version": "${{ inputs.runtime }}",
        }),
      },
      after: {
        ".github/workflows/check.yml": workflow({
          "bun-version": "${{ vars.runtime }}",
        }),
      },
    },
    async ({ repo, since }) => {
      const result = await detectToolchainChanges({ repo, since });
      expect(result.changed).toBe(true);
      expect(
        result.tools.some((tool) => tool === "bun" || tool === "typescript"),
      ).toBe(true);
      let invocations = 0;
      await runSelectedTypecheckParity({
        repo,
        since,
        run: async () => {
          invocations++;
          return true;
        },
        output: () => {
          throw new Error(
            "unclassifiable changed declaration must not skip parity",
          );
        },
      });
      expect(invocations).toBe(1);
    },
  );
});

const unrelatedPnpmResolutions = {
  "linked-library": "link:../library",
  "workspace-library": "workspace:*",
  "file-fixture": "file:../fixture",
  "portal-library": "portal:../library",
  "git-library":
    "git://example.test/library.git#0123456789abcdef0123456789abcdef01234567",
  "github-library":
    "github:example/library#0123456789abcdef0123456789abcdef01234567",
  "git-plus-library":
    "git+https://example.test/library.git#0123456789abcdef0123456789abcdef01234567",
  "archive-library": "https://example.test/library-1.0.0.tgz",
  "catalog-library": "catalog:default",
};
const pnpmLock = (version: string) =>
  stringify({
    lockfileVersion: "9.0",
    importers: {
      ".": {
        devDependencies: {
          typescript: { specifier: ">=6 <8", version },
          compiler: {
            specifier: "npm:typescript@7.0.2",
            version: "typescript@7.0.2",
          },
        },
        dependencies: Object.fromEntries(
          Object.entries(unrelatedPnpmResolutions).map(([name, resolution]) => [
            name,
            { specifier: resolution, version: resolution },
          ]),
        ),
      },
    },
    packages: { "typescript@7.0.2": {}, "typescript@7.0.3": {} },
    snapshots: { "typescript@7.0.2": {}, "typescript@7.0.3": {} },
  });

test("ordinary pnpm protocol resolutions preserve skip selection while compiler lock bumps run parity", async () => {
  await withSnapshots(
    {
      name: "pnpm protocol resolutions",
      base: {
        "package.json": {
          private: true,
          packageManager: "pnpm@12.9.1",
          devDependencies: {
            typescript: ">=6 <8",
            compiler: "npm:typescript@7.0.2",
          },
          dependencies: unrelatedPnpmResolutions,
        },
      },
      before: { "pnpm-lock.yaml": pnpmLock("7.0.2") },
      after: { "pnpm-lock.yaml": pnpmLock("7.0.3") },
    },
    async ({ repo, since }) => {
      const unchanged = await detectToolchainChanges({ repo, since: "HEAD" });
      expect(unchanged.status).toBe("compared");
      expect(unchanged.changed).toBe(false);
      expect(unchanged.tools).toEqual([]);
      let invocations = 0;
      const output: string[] = [];
      expect(
        await runSelectedTypecheckParity({
          repo,
          since: "HEAD",
          run: async () => {
            invocations++;
            return true;
          },
          output: (message) => output.push(message),
        }),
      ).toBe(true);
      expect(invocations).toBe(0);
      expect(output).toHaveLength(1);
      expect(output.at(0)).toContain("parity skipped:");
      const changed = await detectToolchainChanges({ repo, since });
      expect(changed.status).toBe("compared");
      expect(changed.changed).toBe(true);
      expect(changed.tools).toEqual(["typescript"]);
      expect(
        await runSelectedTypecheckParity({
          repo,
          since,
          run: async () => {
            invocations++;
            return false;
          },
          output: () => {
            throw new Error("resolved compiler changes must not skip parity");
          },
        }),
      ).toBe(false);
      expect(invocations).toBe(1);
    },
  );
});
