import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.join(import.meta.dir, "engine-support-cli.ts");

const manifest = (name: string, node?: string, extra = {}) => ({
  name,
  version: "1.0.0",
  ...(node === undefined ? {} : { engines: { node } }),
  ...extra,
});

const withRepository = async (
  initial: Record<string, unknown>,
  check: (
    root: string,
    run: (base?: string) => Bun.SyncSubprocess,
  ) => Promise<void>,
) => {
  const root = await mkdtemp(path.join(tmpdir(), "engine-support-"));
  const write = async (file: string, value: unknown) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), `${JSON.stringify(value)}\n`);
  };
  try {
    await write("package.json", {
      private: true,
      workspaces: ["packages/*"],
    });
    await write(".changeset/config.json", { ignore: [] });
    await write(".changeset/README.md", "changesets\n");
    for (const [file, value] of Object.entries(initial))
      await write(file, value);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: root });
    const run = (base = "HEAD") =>
      Bun.spawnSync([process.execPath, cli, "--base", base], { cwd: root });
    await check(root, run);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const writeJson = async (root: string, file: string, value: unknown) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), `${JSON.stringify(value)}\n`);
};

const writeChangeset = (root: string, bump: "major" | "minor") =>
  writeFile(
    path.join(root, ".changeset/engine.md"),
    `---\n"library": ${bump}\n---\n\nChange support.\n`,
  );

test("narrowing passes with a major and fails with a minor", async () => {
  await withRepository(
    { "packages/library/package.json": manifest("library", ">=18") },
    async (root, run) => {
      await writeJson(
        root,
        "packages/library/package.json",
        manifest("library", ">=20"),
      );
      await writeChangeset(root, "minor");
      const minor = run();
      expect(minor.exitCode).toBe(1);
      expect(minor.stderr.toString()).toContain(
        "library narrows Node support from >=18 to >=20",
      );
      await writeChangeset(root, "major");
      expect(run().exitCode).toBe(0);
    },
  );
});

test("widening needs nothing and adding a range needs a major", async () => {
  await withRepository(
    {
      "packages/library/package.json": manifest("library"),
      "packages/wide/package.json": manifest("wide", ">=20"),
    },
    async (root, run) => {
      await writeJson(
        root,
        "packages/wide/package.json",
        manifest("wide", ">=18"),
      );
      expect(run().exitCode).toBe(0);
      await writeJson(
        root,
        "packages/library/package.json",
        manifest("library", ">=20"),
      );
      expect(run().exitCode).toBe(1);
      await writeChangeset(root, "major");
      expect(run().exitCode).toBe(0);
    },
  );
});

test("new packages are skipped and moved packages are matched by name", async () => {
  await withRepository(
    { "packages/library/package.json": manifest("library", ">=18") },
    async (root, run) => {
      await rm(path.join(root, "packages/library"), { recursive: true });
      await writeJson(
        root,
        "packages/moved/package.json",
        manifest("library", ">=20"),
      );
      await writeJson(
        root,
        "packages/new/package.json",
        manifest("new", ">=22"),
      );
      expect(run().exitCode).toBe(1);
      await writeChangeset(root, "major");
      expect(run().exitCode).toBe(0);
    },
  );
});

test("a derived platform package is released by its owner", async () => {
  await withRepository(
    {
      "packages/library/package.json": manifest("library", ">=18", {
        optionalDependencies: { "library-linux": "1.0.0" },
      }),
      "npm/linux/package.json": manifest("library-linux", ">=18"),
    },
    async (root, run) => {
      await writeJson(
        root,
        "npm/linux/package.json",
        manifest("library-linux", ">=20"),
      );
      await writeChangeset(root, "major");
      expect(run().exitCode).toBe(0);
    },
  );
});

test("consumed changesets without an engine change pass and git errors fail", async () => {
  await withRepository(
    { "packages/library/package.json": manifest("library", ">=18") },
    async (_root, run) => {
      expect(run().exitCode).toBe(0);
      const failure = run("missing-ref");
      expect(failure.exitCode).toBe(1);
      expect(failure.stderr.toString()).toContain("fatal:");
    },
  );
});
