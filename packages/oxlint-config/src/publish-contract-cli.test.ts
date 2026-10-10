import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
