/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import policyInput from "../toolchain.json";
import { cloudSetupPath, generateCloudSetup } from "./cloud-setup";
import { parseCloudSetup } from "./cloud-setup-schema";
import { checkToolchain } from "./toolchain-guard";
import { parseToolchainPolicy } from "./toolchain-schema";

const cli = fileURLToPath(new URL("./cloud-setup-cli.ts", import.meta.url));
const invoke = (root: string, args: string[] = []) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
const declaration = {
  services: [],
  install: "bun install --frozen-lockfile",
};
const withRepository = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-cli-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    await writeFile(
      join(root, "stll-toolchain.json"),
      JSON.stringify({ optOuts: [], cloud: declaration }),
    );
    await writeFile(join(root, ".node-version"), "26.10.0\n");
    execFileSync("git", ["add", "."], { cwd: root });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("cloud CLI generates byte-stable executable output shared with the mandatory guard", async () => {
  await withRepository(async (root) => {
    const cloud = parseCloudSetup(declaration);
    if (cloud === undefined) throw new Error("Missing cloud declaration");
    const expected = generateCloudSetup({
      policy: parseToolchainPolicy(policyInput),
      cloud,
      nodeVersion: "26.10.0",
    });
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const result = invoke(root);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(await readFile(join(root, cloudSetupPath), "utf8")).toBe(expected);
      expect((await stat(join(root, cloudSetupPath))).mode & 0o777).toBe(0o755);
    }
    execFileSync("git", ["add", cloudSetupPath], { cwd: root });
    expect(
      checkToolchain({ root, policy: parseToolchainPolicy(policyInput) }),
    ).toEqual([]);
  });
});

test("cloud CLI refuses symlinks and hard links without modifying outside targets", async () => {
  for (const target of ["parent", "destination", "hard-link"]) {
    await withRepository(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "cloud-cli-outside-"));
      try {
        const sentinel = join(outside, "script.sh");
        await writeFile(sentinel, "unchanged");
        if (target === "parent")
          await symlink(outside, join(root, ".agents"), "dir");
        else {
          await mkdir(join(root, ".agents"));
          if (target === "hard-link")
            await link(sentinel, join(root, cloudSetupPath));
          else await symlink(sentinel, join(root, cloudSetupPath));
        }
        const result = invoke(root);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("cloud setup");
        expect(await readFile(sentinel, "utf8")).toBe("unchanged");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  }
});

test("cloud CLI requires tracked declarations and an exact root Node patch", async () => {
  for (const mutation of ["untracked", "no-cloud", "node-series"]) {
    await withRepository(async (root) => {
      if (mutation === "untracked")
        execFileSync("git", ["rm", "--cached", "stll-toolchain.json"], {
          cwd: root,
        });
      if (mutation === "no-cloud")
        await writeFile(join(root, "stll-toolchain.json"), '{"optOuts":[]}');
      if (mutation === "node-series")
        await writeFile(join(root, ".node-version"), "26.x");
      expect(invoke(root).status).toBe(1);
    });
  }
});

test("cloud CLI help succeeds outside a repository and unknown arguments fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-cli-help-"));
  try {
    const help = invoke(root, ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: stll-cloud-setup");
    expect(help.stderr).toBe("");
    for (const args of [["--unknown"], ["--check"], ["--help", "extra"]]) {
      const result = invoke(root, args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage:");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
