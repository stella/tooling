import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.join(import.meta.dir, "publish-contract-cli.ts");

const writeReleaseWorkflow = async (root: string) => {
  const directory = path.join(root, ".github/workflows");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "publish.yml"),
    await readFile(
      new URL("../../../.github/workflows/publish.yml", import.meta.url),
      "utf8",
    ),
  );
};

test("CLI checks recursively declared packages and rejects unnamed public members", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publish-contract-cli-"));
  const writeManifest = async (directory: string, manifest: unknown) => {
    const location = path.join(root, directory);
    await mkdir(location, { recursive: true });
    await writeFile(
      path.join(location, "package.json"),
      JSON.stringify(manifest),
    );
  };
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, cli, ...args], { cwd: root });
  try {
    await writeManifest(".", { private: true, workspaces: ["packages/*"] });
    await writeManifest("packages/group", {
      private: true,
      workspaces: ["nested/*", "!nested/excluded"],
    });
    await writeManifest("packages/group/nested/library", {
      name: "nested-library",
      version: "1.0.0",
      exports: "./data.json",
    });
    await writeManifest("packages/group/nested/excluded", {
      exports: "./data.json",
    });
    await writeManifest("fixtures", { workspaces: ["nested/*"] });
    await writeManifest("fixtures/nested/library", { name: "nested-library" });
    await writeReleaseWorkflow(root);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    const written = run("--write");
    expect(written.stderr.toString()).toBe("");
    expect(written.exitCode).toBe(0);
    expect(
      existsSync(
        path.join(root, "packages/group/nested/library/publish-contract.json"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(root, "packages/group/nested/excluded/publish-contract.json"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(root, "fixtures/nested/library/publish-contract.json"),
      ),
    ).toBe(false);
    expect(run().exitCode).toBe(0);
    await writeManifest("packages/group/nested/library", {
      version: "1.0.0",
      exports: "./data.json",
    });
    const unnamed = run();
    expect(unnamed.exitCode).toBe(1);
    expect(unnamed.stderr.toString()).toContain(
      "public consumer package requires a valid npm name: packages/group/nested/library",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI read and write reject unsupported published manifests without replacing their contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publish-contract-manifest-"));
  const manifestFile = path.join(root, "package.json");
  const contractFile = path.join(root, "publish-contract.json");
  const manifest = {
    name: "library",
    version: "1.0.0",
    exports: "./data.json",
  };
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, cli, ...args], { cwd: root });
  try {
    await writeFile(manifestFile, JSON.stringify(manifest));
    await writeReleaseWorkflow(root);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "package.json", ".github"], { cwd: root });
    const written = run("--write");
    expect(written.stderr.toString()).toBe("");
    expect(written.exitCode).toBe(0);
    const committed = await readFile(contractFile, "utf8");
    for (const mutation of [
      {
        manifest: {
          ...manifest,
          publishConfig: { exports: "./published.json" },
        },
        message: "npm pack does not apply differing publishConfig.exports",
      },
      {
        manifest: { ...manifest, version: "latest" },
        message: "semver-valid version",
      },
      {
        manifest: { ...manifest, name: "Invalid Name" },
        message: "valid npm name",
      },
      {
        manifest: { ...manifest, bundleDependencies: [] },
        message: "does not support bundleDependencies",
      },
      {
        manifest: { ...manifest, bundledDependencies: false },
        message: "does not support bundledDependencies",
      },
    ]) {
      await writeFile(manifestFile, JSON.stringify(mutation.manifest));
      for (const args of [[], ["--write"]]) {
        const result = run(...args);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain(mutation.message);
        expect(await readFile(contractFile, "utf8")).toBe(committed);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI artifact mode checks real tarball import closure and the matching workspace contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publish-contract-artifact-"));
  const require = createRequire(import.meta.url);
  const manifest = {
    name: "artifact-library",
    version: "1.0.0",
    type: "module",
    exports: "./dist/index.mjs",
    engines: { node: "^20.19.0 || >=22.12.0" },
    scripts: { build: "tsdown" },
  };
  const archive = path.join(root, "artifact.tgz");
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, cli, ...args], { cwd: root });
  const pack = () =>
    execFileSync("tar", ["-czf", archive, "package"], { cwd: root });
  const writePackedManifest = (value: unknown) =>
    writeFile(path.join(root, "package/package.json"), JSON.stringify(value));
  try {
    await mkdir(path.join(root, "node_modules"));
    await symlink(
      path.dirname(require.resolve("tsdown/package.json")),
      path.join(root, "node_modules/tsdown"),
    );
    await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
    await writeFile(path.join(root, "entry.js"), "export {};\n");
    await writeFile(
      path.join(root, "tsdown.config.mjs"),
      "export default { entry: ['entry.js'], dts: false, target: 'node20.19.0' };\n",
    );
    await writeReleaseWorkflow(root);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync(
      "git",
      ["add", "package.json", "entry.js", "tsdown.config.mjs", ".github"],
      { cwd: root },
    );
    const written = run("--write");
    expect(written.stderr.toString()).toBe("");
    expect(written.exitCode).toBe(0);
    const originalContract = await readFile(
      path.join(root, "publish-contract.json"),
      "utf8",
    );
    await mkdir(path.join(root, "package/dist"), { recursive: true });
    await writePackedManifest(manifest);
    await writeFile(
      path.join(root, "package/dist/index.mjs"),
      "import './helper.mjs'; throw new Error('artifact code must never execute');\n",
    );
    pack();
    const missing = run("--artifact", archive);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("helper.mjs");
    await writeFile(path.join(root, "package/dist/helper.mjs"), "export {};\n");
    pack();
    const valid = run("--artifact", archive);
    expect(valid.stderr.toString()).toBe("");
    expect(valid.exitCode).toBe(0);
    await writePackedManifest({ ...manifest, exports: "./dist/helper.mjs" });
    pack();
    const drift = run("--artifact", archive);
    expect(drift.exitCode).toBe(1);
    expect(drift.stderr.toString()).toContain(
      "published entryPoints.exports differs",
    );
    for (const packedManifest of [
      { ...manifest, name: "unknown-package" },
      { ...manifest, private: true },
    ]) {
      await writePackedManifest(packedManifest);
      pack();
      const unknown = run("--artifact", archive);
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stderr.toString()).toContain(
        "declared public workspace package",
      );
    }
    expect(
      await readFile(path.join(root, "publish-contract.json"), "utf8"),
    ).toBe(originalContract);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ ...manifest, exports: "./dist/changed.mjs" }),
    );
    const sourceDrift = run("--artifact", path.join(root, "absent.tgz"));
    expect(sourceDrift.exitCode).toBe(1);
    expect(sourceDrift.stderr.toString()).toContain(
      "published entryPoints.exports differs",
    );
    expect(sourceDrift.stderr.toString()).not.toContain("tar:");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI artifact mode accepts exactly one explicit archive and never writes contracts", () => {
  for (const args of [
    ["--artifact"],
    ["--artifact", ""],
    ["--artifact", "one.tgz", "two.tgz"],
    ["--write", "--artifact", "one.tgz"],
    ["--artifact", "one.tgz", "--write"],
    ["--artifact", "--write"],
  ]) {
    const result = Bun.spawnSync([process.execPath, cli, ...args]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Expected no arguments, --write, or --artifact",
    );
  }
});
