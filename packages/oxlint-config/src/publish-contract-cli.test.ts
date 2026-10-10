import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.join(import.meta.dir, "publish-contract-cli.ts");

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
      exports: "./data.json",
    });
    await writeManifest("packages/group/nested/excluded", {
      exports: "./data.json",
    });
    await writeManifest("fixtures", { workspaces: ["nested/*"] });
    await writeManifest("fixtures/nested/library", { name: "nested-library" });
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
      exports: "./data.json",
    });
    const unnamed = run();
    expect(unnamed.exitCode).toBe(1);
    expect(unnamed.stderr.toString()).toContain(
      "packages/group/nested/library/package.json: published package needs a name",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
