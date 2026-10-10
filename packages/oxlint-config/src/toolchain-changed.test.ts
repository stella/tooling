import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

import { detectToolchainChanges } from "./toolchain-changed";
import {
  changedRecord,
  parseChangedJson,
  parseChangedLock,
} from "./toolchain-changed-locks";
import { parseParityArguments } from "./typecheck-parity-args";
import { runSelectedTypecheckParity } from "./typecheck-parity-selection";

test("the repository's actual HEAD resolves without executing installed tooling", async () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const result = await detectToolchainChanges({ repo, since: "HEAD" });
  expect(result.status).toBe("compared");
  expect(result.changed).toBe(false);
  expect(result.tools).toEqual([]);
  if (result.status === "compared") {
    expect(result.current.bun.length).toBe(1);
    expect(result.current.typescript.length).toBeGreaterThan(0);
  }
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const fixture = () => {
  const repo = mkdtempSync(path.join(tmpdir(), "toolchain-changed-"));
  directories.push(repo);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "-q"]);
  const write = (file: string, value: unknown) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(
      path.join(repo, file),
      typeof value === "string" ? value : JSON.stringify(value),
    );
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
  return { repo, write, commit };
};

const runtimeActions = [
  {
    uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    input: "bun-version",
    exact: "1.4.3",
  },
  {
    uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    input: "node-version",
    exact: "26.10.0",
  },
] as const;
const setupDeclaration = (surface: string, step: Record<string, unknown>) =>
  surface === "workflow"
    ? { jobs: { runtime: { "runs-on": "ubuntu-latest", steps: [step] } } }
    : { runs: { using: "composite", steps: [step] } };

for (const surface of ["workflow", "composite"])
  for (const runtime of runtimeActions)
    test(`${surface} ${runtime.input} selectors require an immutable release even without a commit change`, async () => {
      for (const selector of [
        "latest",
        "${{ vars.X }}",
        "1.x",
        "",
        undefined,
        runtime.exact,
      ]) {
        const { repo, write, commit } = fixture();
        write("package.json", { private: true, packageManager: "bun@1.4.3" });
        write(
          surface === "workflow"
            ? ".github/workflows/runtime.yml"
            : ".github/actions/runtime/action.yml",
          setupDeclaration(surface, {
            uses: runtime.uses,
            ...(selector === undefined
              ? {}
              : { with: { [runtime.input]: selector } }),
          }),
        );
        const since = commit();
        const result = await detectToolchainChanges({ repo, since });
        const stable = selector === runtime.exact;
        expect(result.status).toBe(stable ? "compared" : "unreadable");
        expect(result.changed).toBe(!stable);
        let invocations = 0;
        await runSelectedTypecheckParity({
          repo,
          since,
          run: async () => {
            invocations++;
            return true;
          },
          output: () => {},
        });
        expect(invocations).toBe(stable ? 0 : 1);
      }
    });

for (const surface of ["workflow", "composite"])
  for (const runtime of runtimeActions)
    test(`${surface} ${runtime.input}-file validates the selected bytes, not only the tracked path`, async () => {
      for (const selector of [
        "latest",
        "${{ vars.X }}",
        "1.x",
        "",
        runtime.exact,
      ]) {
        const { repo, write, commit } = fixture();
        write("package.json", { private: true, packageManager: "bun@1.4.3" });
        write("config/runtime.txt", selector + "\n");
        write(
          surface === "workflow"
            ? ".github/workflows/runtime.yml"
            : ".github/actions/runtime/action.yml",
          setupDeclaration(surface, {
            uses: runtime.uses,
            with: { [runtime.input + "-file"]: "config/runtime.txt" },
          }),
        );
        const since = commit();
        const result = await detectToolchainChanges({ repo, since });
        const stable = selector === runtime.exact;
        expect(result.status).toBe(stable ? "compared" : "unreadable");
        expect(result.changed).toBe(!stable);
        let invocations = 0;
        await runSelectedTypecheckParity({
          repo,
          since,
          run: async () => {
            invocations++;
            return true;
          },
          output: () => {},
        });
        expect(invocations).toBe(stable ? 0 : 1);
      }
    });

test("non-Node setup version files reject floating runtime series", async () => {
  for (const runtime of [
    { name: "python", exact: "3.13.0", floating: "3.13" },
    { name: "go", exact: "1.24.3", floating: "1.24" },
    { name: "java", exact: "21.0.2", floating: "21" },
  ]) {
    for (const selector of [runtime.exact, runtime.floating]) {
      const { repo, write, commit } = fixture();
      const file =
        runtime.name === "go" ? "config/go.mod" : "config/runtime.txt";
      write("package.json", { private: true, packageManager: "bun@1.4.3" });
      write(
        file,
        runtime.name === "go"
          ? `module example.test/library\ngo ${selector}\n`
          : selector + "\n",
      );
      write(
        ".github/actions/runtime/action.yml",
        setupDeclaration("composite", {
          uses: `actions/setup-${runtime.name}@${"1".repeat(40)}`,
          with: { [runtime.name + "-version-file"]: file },
        }),
      );
      const since = commit();
      const stable = selector === runtime.exact;
      expect(await detectToolchainChanges({ repo, since })).toMatchObject({
        status: stable ? "compared" : "unreadable",
        changed: !stable,
      });
    }
  }
});

test("Bun JSON version selectors validate the exact packageManager release", async () => {
  for (const manager of [
    "bun@1.4.3",
    "bun@latest",
    "bun@1.x",
    "bun@${{ vars.X }}",
    undefined,
  ]) {
    const { repo, write, commit } = fixture();
    write("package.json", { private: true, packageManager: "bun@1.4.3" });
    write("config/runtime.json", {
      private: true,
      ...(manager === undefined ? {} : { packageManager: manager }),
    });
    write(
      ".github/workflows/runtime.yml",
      setupDeclaration("workflow", {
        uses: runtimeActions[0].uses,
        with: { "bun-version-file": "config/runtime.json" },
      }),
    );
    const since = commit();
    const stable = manager === "bun@1.4.3";
    expect(await detectToolchainChanges({ repo, since })).toMatchObject({
      status: stable ? "compared" : "unreadable",
      changed: !stable,
    });
  }
});

test("Go file selection validates an overriding toolchain directive", async () => {
  for (const selector of ["go1.24.4", "go1.25rc1", "go1.25"]) {
    const { repo, write, commit } = fixture();
    write("package.json", { private: true, packageManager: "bun@1.4.3" });
    write(
      "config/go.mod",
      `module example.test/library\ngo 1.24.0\ntoolchain ${selector}\n`,
    );
    write(
      ".github/workflows/runtime.yml",
      setupDeclaration("workflow", {
        uses: `actions/setup-go@${"1".repeat(40)}`,
        with: { "go-version-file": "config/go.mod" },
      }),
    );
    const since = commit();
    const stable = selector === "go1.24.4";
    expect(await detectToolchainChanges({ repo, since })).toMatchObject({
      status: stable ? "compared" : "unreadable",
      changed: !stable,
    });
  }
});

test("Rust setup toolchains require an immutable stable or dated nightly release", async () => {
  for (const selector of ["1.96.0", "nightly-2026-04-16", "nightly"]) {
    const { repo, write, commit } = fixture();
    write("package.json", { private: true, packageManager: "bun@1.4.3" });
    write(
      ".github/actions/runtime/action.yml",
      setupDeclaration("composite", {
        uses: `dtolnay/rust-toolchain@${"1".repeat(40)}`,
        with: { toolchain: selector },
      }),
    );
    const since = commit();
    const stable = selector !== "nightly";
    expect(await detectToolchainChanges({ repo, since })).toMatchObject({
      status: stable ? "compared" : "unreadable",
      changed: !stable,
    });
  }
});

test("canonical Node runtime selectors cannot float without a setup action", async () => {
  for (const declaration of [
    { file: ".node-version", content: (version: string) => version + "\n" },
    { file: ".nvmrc", content: (version: string) => version + "\n" },
    {
      file: ".tool-versions",
      content: (version: string) => `nodejs ${version}\n`,
    },
    {
      file: "mise.toml",
      content: (version: string) => `[tools]\nnode = "${version}"\n`,
    },
    {
      file: ".npmrc",
      content: (version: string) => `use-node-version=${version}\n`,
    },
    {
      file: "pnpm-workspace.yaml",
      content: (version: string) =>
        `packages: []\nuseNodeVersion: '${version}'\n`,
    },
  ]) {
    for (const version of ["26.10.0", "latest"]) {
      const { repo, write, commit } = fixture();
      write("package.json", { private: true, packageManager: "bun@1.4.3" });
      write(declaration.file, declaration.content(version));
      const since = commit();
      const stable = version === "26.10.0";
      expect(await detectToolchainChanges({ repo, since })).toMatchObject({
        status: stable ? "compared" : "unreadable",
        changed: !stable,
      });
    }
  }
});

test("committed quoted Yarn Classic compiler selectors bind unchanged and changed artifacts", async () => {
  const { repo, write, commit } = fixture();
  write("package.json", {
    private: true,
    packageManager: "yarn@1.22.22",
    devDependencies: { "@types/bun": ">=1.1.0 <2", typescript: ">=7 <8" },
  });
  const lock = (variant: string) => {
    const version = variant === "version" ? "1.1.1" : "1.1.0";
    const digest = Buffer.alloc(
      64,
      variant === "source" ? "changed" : "same",
    ).toString("base64");
    const artifact = variant === "source" ? "changed" : "original";
    return `# yarn lockfile v1\n\n"@types/bun@>=1.1.0 <2":\n  version "${version}"\n  resolved "https://example.test/bun-${artifact}.tgz"\n  integrity sha512-${digest}\n\n"typescript@>=7 <8":\n  version "7.0.2"\n  resolved "https://example.test/typescript.tgz"\n  integrity sha512-${digest}\n`;
  };
  write("yarn.lock", lock("original"));
  const since = commit();
  for (const variant of ["original", "source", "version"]) {
    const changed = variant !== "original";
    if (changed) {
      write("yarn.lock", lock(variant));
      commit();
    }
    expect(await detectToolchainChanges({ repo, since })).toMatchObject({
      status: "compared",
      changed,
      tools: changed ? ["typescript"] : [],
    });
    let invocations = 0;
    await runSelectedTypecheckParity({
      repo,
      since,
      run: async () => {
        invocations++;
        return true;
      },
      output: () => {},
    });
    expect(invocations).toBe(changed ? 1 : 0);
  }
});

for (const location of ["catalog", "catalogs", "workspaces", "pnpm"])
  test(`compiler catalog alias in ${location} retains patch bytes and canonical resolution`, async () => {
    const { repo, write, commit } = fixture();
    const aliases = { compiler: "npm:typescript@7.0.2" };
    const root = {
      packageManager: "bun@1.4.3",
      devDependencies: { compiler: "catalog:" },
    };
    if (location === "catalog")
      write("package.json", { ...root, catalog: aliases });
    if (location === "catalogs")
      write("package.json", {
        ...root,
        devDependencies: { compiler: "catalog:tools" },
        catalogs: { tools: aliases },
      });
    if (location === "workspaces")
      write("package.json", {
        ...root,
        workspaces: { packages: [], catalog: aliases },
      });
    if (location === "pnpm") {
      write("package.json", root);
      write(
        "pnpm-workspace.yaml",
        "packages: []\ncatalog:\n  compiler: npm:typescript@7.0.2\n",
      );
    }
    const lock = {
      lockfileVersion: 1,
      workspaces: { "": { devDependencies: root.devDependencies } },
      packages: { compiler: ["typescript@7.0.2"] },
    };
    write("bun.lock", lock);
    write("custom/compiler+7.0.2.patch", "before\n");
    const since = commit();
    write("custom/compiler+7.0.2.patch", "after\n");
    commit();
    expect(await detectToolchainChanges({ repo, since })).toMatchObject({
      status: "compared",
      tools: ["typescript"],
    });
    write("bun.lock", { ...lock, packages: { compiler: ["compiler@7.0.2"] } });
    commit();
    expect(await detectToolchainChanges({ repo, since: "HEAD" })).toMatchObject(
      { status: "unreadable", changed: true },
    );
  });

test("compiler catalog archives require their own immutable source evidence", async () => {
  const { repo, write, commit } = fixture();
  write("package.json", {
    packageManager: "bun@1.4.3",
    devDependencies: { typescript: "catalog:", ordinary: "catalog:absent" },
    catalog: { typescript: "file:./compiler.tgz" },
  });
  write("bun.lock", {
    lockfileVersion: 1,
    workspaces: { "": { devDependencies: { typescript: "catalog:" } } },
    packages: {
      typescript: [
        "typescript@7.0.2",
        "file:./compiler.tgz",
        {},
        `sha512-${"A".repeat(86)}==`,
      ],
    },
  });
  commit();
  expect(await detectToolchainChanges({ repo, since: "HEAD" })).toMatchObject({
    status: "compared",
    changed: false,
  });
});

test("the nearest catalog owner controls compiler source validation", async () => {
  const { repo, write, commit } = fixture();
  write("package.json", {
    packageManager: "bun@1.4.3",
    workspaces: ["packages/*"],
    catalog: { typescript: "7.0.2" },
  });
  write("packages/child/package.json", {
    name: "child",
    devDependencies: { typescript: "catalog:" },
    catalog: { typescript: "file:../compiler" },
  });
  write("bun.lock", {
    lockfileVersion: 1,
    workspaces: {
      "": {},
      "packages/child": { devDependencies: { typescript: "catalog:" } },
    },
    packages: {
      typescript: ["typescript@7.0.2", "", {}, `sha512-${"A".repeat(86)}==`],
    },
  });
  commit();
  expect(await detectToolchainChanges({ repo, since: "HEAD" })).toMatchObject({
    status: "unreadable",
    changed: true,
  });
});

for (const source of [
  "file:../compiler",
  "link:../compiler",
  "portal:../compiler",
  "workspace:*",
  "github:example/compiler#main",
])
  test(`effective compiler catalog ${source} cannot borrow registry integrity`, async () => {
    const { repo, write, commit } = fixture();
    write("package.json", {
      packageManager: "bun@1.4.3",
      devDependencies: { typescript: "catalog:" },
      catalog: { typescript: source },
    });
    write("bun.lock", {
      lockfileVersion: 1,
      workspaces: { "": { devDependencies: { typescript: "catalog:" } } },
      packages: {
        typescript: ["typescript@7.0.2", "", {}, `sha512-${"A".repeat(86)}==`],
      },
    });
    commit();
    expect(await detectToolchainChanges({ repo, since: "HEAD" })).toMatchObject(
      { status: "unreadable", changed: true },
    );
  });
test("exact Bun image variants normalize while floating selectors always run parity", async () => {
  for (const variant of ["alpine", "slim", "debian", "distroless"]) {
    const { repo, write, commit } = fixture();
    write("package.json", { packageManager: "bun@1.4.3" });
    write("Dockerfile", `FROM oven/bun:1.4.3-${variant}\n`);
    commit();
    const result = await detectToolchainChanges({ repo, since: "HEAD" });
    expect(result.status).toBe("compared");
    expect(result.changed).toBe(false);
    if (result.status === "compared")
      expect(result.current.bun).toEqual(["1.4.3"]);
  }
  for (const tag of ["", ":latest", ":1", ":1.4", ":canary", ":1-alpine"]) {
    for (const file of ["Dockerfile", "compose.yaml"]) {
      const { repo, write, commit } = fixture();
      write("package.json", { packageManager: "bun@1.4.3" });
      const image = `oven/bun${tag}`;
      write(
        file,
        file === "Dockerfile"
          ? `FROM ${image}\n`
          : `services:\n  runtime:\n    image: ${image}\n`,
      );
      commit();
      const result = await detectToolchainChanges({ repo, since: "HEAD" });
      expect(result.status).toBe("unreadable");
      expect(result.changed).toBe(true);
      let calls = 0;
      await runSelectedTypecheckParity({
        repo,
        since: "HEAD",
        detect: async () => result,
        run: async () => {
          calls += 1;
          return true;
        },
      });
      expect(calls).toBe(1);
    }
  }
});

const bunLock = (swap: boolean) => ({
  lockfileVersion: 1,
  workspaces: {
    "": { devDependencies: { typescript: ">=6" } },
    "packages/a": { devDependencies: { typescript: ">=6" } },
  },
  packages: {
    typescript: [`typescript@${swap ? "6.0.3" : "7.0.2"}`],
    "a/typescript": [`typescript@${swap ? "7.0.2" : "6.0.3"}`],
  },
});

test("JSONC preserves quoted comments, escaped quotes and URL slashes", () => {
  expect(
    parseChangedJson(
      '{/* comment */"url":"https://example.test/a//b","quote":"\\\"/*literal*/", "list":[1,],}',
    ),
  ).toEqual({
    url: "https://example.test/a//b",
    quote: '"/*literal*/',
    list: [1],
  });
  expect(() => parseChangedJson("{/*unfinished")).toThrow("Unterminated");
});

test("Bun resolution locations prevent root/member compiler swaps from looking unchanged", async () => {
  const { repo, write, commit } = fixture();
  write("package.json", {
    packageManager: "bun@1.4.3",
    workspaces: ["packages/*"],
    devDependencies: { typescript: ">=6" },
  });
  write("packages/a/package.json", {
    name: "a",
    devDependencies: { typescript: ">=6" },
  });
  write("bun.lock", bunLock(false));
  const since = commit();
  write("bun.lock", bunLock(true));
  commit();
  const result = await detectToolchainChanges({ repo, since });
  expect(result.status).toBe("compared");
  expect(result.tools).toEqual(["typescript"]);
  if (result.status === "compared")
    expect(result.current).toEqual({
      bun: ["1.4.3"],
      typescript: ["typescript@6.0.3", "typescript@7.0.2"],
    });
});

test("pnpm importer alias swaps detect changes with an unchanged global package pool", async () => {
  const { repo, write, commit } = fixture();
  write("package.json", {
    workspaces: ["packages/*"],
    devDependencies: { compiler: "npm:typescript@>=6" },
  });
  write("packages/a/package.json", {
    devDependencies: { compiler: "npm:typescript@>=6" },
  });
  const lock = (swap: boolean) =>
    `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      compiler:\n        specifier: npm:typescript@>=6\n        version: typescript@${swap ? "6.0.3" : "7.0.2"}\n  packages/a:\n    devDependencies:\n      compiler:\n        specifier: npm:typescript@>=6\n        version: typescript@${swap ? "7.0.2" : "6.0.3"}\npackages:\n  typescript@6.0.3: {}\n  typescript@7.0.2: {}\n`;
  write("pnpm-lock.yaml", lock(false));
  const since = commit();
  write("pnpm-lock.yaml", lock(true));
  commit();
  expect((await detectToolchainChanges({ repo, since })).tools).toEqual([
    "typescript",
  ]);
});

test("npm nested resolutions retain their installation locations", async () => {
  const { repo, write, commit } = fixture();
  write("package.json", { devDependencies: { typescript: ">=6" } });
  const lock = (swap: boolean) => ({
    lockfileVersion: 3,
    packages: {
      "": { devDependencies: { typescript: ">=6" } },
      "node_modules/typescript": { version: swap ? "6.0.3" : "7.0.2" },
      "node_modules/a/node_modules/typescript": {
        version: swap ? "7.0.2" : "6.0.3",
      },
    },
  });
  write("package-lock.json", lock(false));
  const since = commit();
  write("package-lock.json", lock(true));
  commit();
  expect((await detectToolchainChanges({ repo, since })).tools).toEqual([
    "typescript",
  ]);
});

test("immutable HEAD snapshots ignore working files and unrelated lock dependencies", async () => {
  const { repo, write, commit } = fixture();
  write("package.json", { packageManager: "bun@1.4.3" });
  write("bun.lock", {
    lockfileVersion: 1,
    workspaces: { "": {} },
    packages: { unrelated: ["unrelated@1.0.0"] },
  });
  const since = commit();
  write("bun.lock", {
    lockfileVersion: 1,
    workspaces: { "": {} },
    packages: { unrelated: ["unrelated@2.0.0"] },
  });
  commit();
  write(".bun-version", "1.5.0");
  expect(await detectToolchainChanges({ repo, since })).toEqual({
    status: "compared",
    changed: false,
    tools: [],
    current: { bun: ["1.4.3"], typescript: [] },
  });
});

test("Bun, npm and pnpm compiler specifier edits retain resolved versions but run parity", async () => {
  for (const format of ["bun", "npm", "pnpm"] as const) {
    const { repo, write, commit } = fixture();
    const writeSnapshot = (range: string) => {
      write("package.json", { devDependencies: { typescript: range } });
      if (format === "bun")
        write("bun.lock", {
          lockfileVersion: 1,
          workspaces: { "": { devDependencies: { typescript: range } } },
          packages: { typescript: ["typescript@7.0.2"] },
        });
      else if (format === "npm")
        write("package-lock.json", {
          lockfileVersion: 3,
          packages: {
            "": { devDependencies: { typescript: range } },
            "node_modules/typescript": { version: "7.0.2" },
          },
        });
      else
        write(
          "pnpm-lock.yaml",
          `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      typescript:\n        specifier: '${range}'\n        version: 7.0.2\npackages:\n  typescript@7.0.2: {}\n`,
        );
    };
    writeSnapshot("^7");
    const since = commit();
    writeSnapshot(">=7 <8");
    commit();
    expect(await detectToolchainChanges({ repo, since })).toEqual({
      status: "compared",
      changed: true,
      tools: ["typescript"],
      current: { bun: [], typescript: ["typescript@7.0.2"] },
    });
  }
});

test("a compatible child compiler cannot conceal the root's stale resolution", async () => {
  for (const format of ["bun", "npm"] as const) {
    const { repo, write, commit } = fixture();
    write("package.json", {
      workspaces: ["packages/*"],
      devDependencies: { typescript: "^6" },
    });
    write("packages/a/package.json", {
      name: "a",
      devDependencies: { typescript: "^6" },
    });
    if (format === "bun") write("bun.lock", bunLock(false));
    else
      write("package-lock.json", {
        lockfileVersion: 3,
        packages: {
          "": { devDependencies: { typescript: "^6" } },
          "node_modules/typescript": { version: "7.0.2" },
          "packages/a/node_modules/typescript": { version: "6.0.3" },
        },
      });
    commit();
    const result = await detectToolchainChanges({ repo, since: "HEAD" });
    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable")
      expect(result.error).toContain(
        "does not satisfy manifest: package.json:typescript",
      );
  }
});

test("switching the declared manager binds a different effective compiler in a fixed lock pool", async () => {
  const { repo, write, commit } = fixture();
  write("package.json", {
    packageManager: "npm@11.6.0",
    devDependencies: { typescript: ">=6" },
  });
  write("package-lock.json", {
    lockfileVersion: 3,
    packages: {
      "": { devDependencies: { typescript: ">=6" } },
      "node_modules/typescript": { version: "6.0.3" },
    },
  });
  write(
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      typescript:\n        version: 7.0.2\npackages:\n  typescript@7.0.2: {}\n",
  );
  const since = commit();
  write("package.json", {
    packageManager: "pnpm@12.9.1",
    devDependencies: { typescript: ">=6" },
  });
  commit();
  const result = await detectToolchainChanges({ repo, since });
  expect(result.status).toBe("compared");
  expect(result.tools).toEqual(["typescript", "shared"]);
});

test("nearest lock ownership outranks a longer root lock filename", async () => {
  const { repo, write, commit } = fixture();
  write("package.json", {
    packageManager: "npm@11.6.0",
    devDependencies: { typescript: "^6" },
  });
  write("npm-shrinkwrap.json", {
    lockfileVersion: 3,
    packages: {
      "": { devDependencies: { typescript: "^6" } },
      "node_modules/typescript": { version: "6.0.3" },
    },
  });
  write("a/package.json", {
    name: "a",
    packageManager: "bun@1.4.3",
    devDependencies: { typescript: "^7" },
  });
  const lock = (version: string) => ({
    lockfileVersion: 1,
    workspaces: { "": { devDependencies: { typescript: "^7" } } },
    packages: { typescript: [`typescript@${version}`] },
  });
  write("a/bun.lock", lock("7.0.2"));
  const since = commit();
  const unchanged = await detectToolchainChanges({ repo, since });
  expect(unchanged.status).toBe("compared");
  expect(unchanged.changed).toBe(false);
  write("a/bun.lock", lock("7.0.3"));
  commit();
  const changed = await detectToolchainChanges({ repo, since });
  expect(changed.status).toBe("compared");
  expect(changed.tools).toEqual(["typescript"]);
});

test("runtime changes and workflow fingerprints classify their independent categories", async () => {
  const { repo, write, commit } = fixture();
  write("package.json", { packageManager: "bun@1.4.3" });
  write(".node-version", "26.0.0");
  write(".github/workflows/ci.yml", "jobs: {}\n");
  const since = commit();
  write("package.json", { packageManager: "bun@1.4.4" });
  write(".node-version", "26.1.0");
  write(".github/workflows/ci.yml", "name: CI\njobs: {}\n");
  commit();
  expect((await detectToolchainChanges({ repo, since })).tools).toEqual([
    "bun",
    "node",
    "typescript",
    "shared",
  ]);
});

test("unresolved dependencies, unknown refs and conflicting Bun selectors fail closed", async () => {
  const { repo, write, commit } = fixture();
  write("package.json", {
    packageManager: "bun@1.4.3",
    devDependencies: { typescript: "^7" },
  });
  const since = commit();
  for (const reference of [since, "missing-reference"]) {
    const result = await detectToolchainChanges({ repo, since: reference });
    expect(result.status).toBe("unreadable");
    expect(result.changed).toBe(true);
  }
  write("package.json", {
    packageManager: "bun@1.4.3",
    workspaces: ["packages/*"],
  });
  write("packages/a/package.json", { packageManager: "bun@1.4.4" });
  commit();
  expect((await detectToolchainChanges({ repo, since: "HEAD" })).status).toBe(
    "unreadable",
  );
});

test("supported lock generations resolve aliases and reject unknown tool resolutions", () => {
  for (const version of [1, 2, 3]) {
    const source =
      version === 1
        ? { dependencies: { compat: { version: "npm:typescript@6.0.3" } } }
        : {
            packages: {
              "": {},
              "node_modules/compat": { name: "typescript", version: "6.0.3" },
            },
          };
    expect(
      parseChangedLock({
        file: "package-lock.json",
        text: JSON.stringify({ lockfileVersion: version, ...source }),
      }).resolutions.at(0)?.name,
    ).toBe("typescript");
  }
  for (const version of [5.4, 6, 9]) {
    const key = version === 9 ? "typescript@7.0.2" : "/typescript/7.0.2";
    expect(
      parseChangedLock({
        file: "pnpm-lock.yaml",
        text: `lockfileVersion: ${version}\npackages:\n  '${key}': {}\n`,
      }).resolutions.at(0)?.version,
    ).toBe("7.0.2");
  }
  expect(() =>
    parseChangedLock({
      file: "bun.lock",
      text: JSON.stringify({
        lockfileVersion: 1,
        workspaces: { "": {} },
        packages: { typescript: ["typescript@latest"] },
      }),
    }),
  ).toThrow("Unresolved");
});

test("CI event-base wiring invokes parity for a committed compiler bump", async () => {
  const workflow = parseDocument(
    readFileSync(
      new URL("../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const document: unknown = workflow.toJS({ maxAliasCount: 100 });
  if (!changedRecord(document) || !changedRecord(document["jobs"]))
    throw new Error("missing workflow jobs");
  const parityJobs = Object.values(document["jobs"]).filter(
    (job) =>
      changedRecord(job) &&
      Array.isArray(job["steps"]) &&
      job["steps"].some(
        (step: unknown) =>
          changedRecord(step) &&
          typeof step["run"] === "string" &&
          step["run"].includes("check:typecheck-parity"),
      ),
  );
  const job = parityJobs.at(0);
  if (parityJobs.length !== 1 || !changedRecord(job))
    throw new Error(
      "expected exactly one workflow job running typecheck parity",
    );
  const environment = job["env"];
  if (!changedRecord(environment))
    throw new Error("missing parity job environment");
  const baseExpression = environment["TOOLCHAIN_BASE"];
  expect(typeof baseExpression).toBe("string");
  if (typeof baseExpression !== "string") throw new Error("missing event base");
  for (const source of [
    "github.event.pull_request.base.sha",
    "github.event.merge_group.base_sha",
    "github.event.before",
    "unavailable-toolchain-base",
  ])
    expect(baseExpression).toContain(source);
  const steps = job["steps"];
  if (!Array.isArray(steps)) throw new Error("missing workflow steps");
  let parityCommand = "";
  let detectorCommand = "";
  let checkoutDepth: unknown;
  for (const step of steps) {
    if (!changedRecord(step)) throw new Error("invalid workflow step");
    if (
      typeof step["uses"] === "string" &&
      step["uses"].startsWith("actions/checkout@") &&
      changedRecord(step["with"]) &&
      step["with"]["repository"] === undefined &&
      step["with"]["path"] === undefined
    )
      checkoutDepth = step["with"]["fetch-depth"];
    const run = step["run"];
    if (typeof run !== "string") continue;
    if (run.includes("check:typecheck-parity")) parityCommand = run;
    if (run.includes("toolchain-changed-cli"))
      detectorCommand =
        run
          .split("\n")
          .find((line) => line.includes("toolchain-changed-cli")) ?? "";
  }
  expect(checkoutDepth).toBe(0);
  expect(parityCommand).not.toBe("");
  expect(detectorCommand).toContain('--since "$TOOLCHAIN_BASE"');
  const { repo, write, commit } = fixture();
  write("package.json", {
    packageManager: "bun@1.4.2",
    devDependencies: { typescript: "7.0.2" },
  });
  write("bun.lock", {
    lockfileVersion: 1,
    workspaces: { "": { devDependencies: { typescript: "7.0.2" } } },
    packages: { typescript: ["typescript@7.0.2"] },
  });
  const base = commit();
  write("package.json", {
    packageManager: "bun@1.4.3",
    devDependencies: { typescript: "7.0.2" },
  });
  commit();
  for (const ref of [base, "0".repeat(40), "unavailable-toolchain-base"]) {
    // Execute the real workflow shell command; capture only the compiler command's argv.
    const captured = execFileSync(
      "bash",
      ["-c", 'bun() { printf "%s\\n" "$@"; }; ' + parityCommand],
      {
        cwd: repo,
        env: { ...process.env, TOOLCHAIN_BASE: ref },
        encoding: "utf8",
      },
    )
      .trim()
      .split("\n");
    expect(captured.slice(0, 2)).toEqual(["run", "check:typecheck-parity"]);
    const args = parseParityArguments(captured.slice(2));
    if (args.mode === "help")
      throw new Error("workflow must select event-based parity");
    expect(args.changedSince).toBe(ref);
    let invocations = 0;
    await runSelectedTypecheckParity({
      repo,
      since: args.changedSince,
      run: async () => {
        invocations += 1;
        return true;
      },
      output: () => {
        throw new Error("a compiler bump must not skip parity");
      },
    });
    expect(invocations).toBe(1);
  }
});
