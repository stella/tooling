import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  link,
  mkdir,
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
import { generateDependabotConfig, parseToolchainPolicy } from "./index";
import { checkDependabot } from "./toolchain-dependabot";
import { readToolchainInputs } from "./toolchain-guard";

const cli = fileURLToPath(new URL("./dependabot-cli.ts", import.meta.url));
const invoke = (root: string, args: string[] = []) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
const policy = parseToolchainPolicy(policyInput).dependabot;
const withRepository = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "dependabot-cli-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    await mkdir(join(root, "wasm"));
    await mkdir(join(root, "oracle"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "bun@1.4.3" }),
    );
    await writeFile(
      join(root, "wasm/package.json"),
      JSON.stringify({ dependencies: { runtime: "1.0.0" } }),
    );
    await writeFile(
      join(root, "oracle/Gemfile"),
      "source 'https://rubygems.org'\n",
    );
    await writeFile(join(root, "oracle/composer.json"), "{}\n");
    execFileSync("git", ["add", "."], { cwd: root });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("public generator and write CLI produce the same complete fixed point", async () => {
  await withRepository(async (root) => {
    // Untracked fixtures are not repository dependency declarations.
    await mkdir(join(root, "untracked"));
    await writeFile(join(root, "untracked/composer.json"), "{}\n");
    const expected = generateDependabotConfig({
      files: readToolchainInputs(root).files,
      policy,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = invoke(root);
      expect(result.status, result.stderr).toBe(0);
      expect(await readFile(join(root, ".github/dependabot.yml"), "utf8")).toBe(
        expected,
      );
    }
    execFileSync("git", ["add", ".github/dependabot.yml"], { cwd: root });
    expect(
      checkDependabot({ files: readToolchainInputs(root).files, policy }),
    ).toEqual([]);
    expect(expected).toContain("package-ecosystem: bundler");
    expect(expected).toContain("package-ecosystem: composer");
    expect(expected).toContain("/wasm");
    expect(expected).not.toContain("/untracked");
    expect(
      (await stat(join(root, ".github/dependabot.yml"))).mode & 0o777,
    ).toBe(0o644);
  });
});

test.skipIf(process.env["CI"] !== "true")(
  "published ESM and CommonJS entries export the generator and the built CLI writes it",
  async () => {
    await withRepository(async (root) => {
      const expected = generateDependabotConfig({
        files: readToolchainInputs(root).files,
        policy,
      });
      for (const format of ["mjs", "cjs"]) {
        const entry = fileURLToPath(
          new URL(`../dist/index.${format}`, import.meta.url),
        );
        const result = spawnSync(
          "node",
          [
            "--input-type=module",
            "-e",
            `
          import fs from "node:fs";
          const entry = await import(process.argv[1]);
          const policy = entry.parseToolchainPolicy(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
          process.stdout.write(entry.generateDependabotConfig({ files: JSON.parse(process.argv[3]), policy: policy.dependabot }));
        `,
            entry,
            fileURLToPath(new URL("../toolchain.json", import.meta.url)),
            JSON.stringify(readToolchainInputs(root).files),
          ],
          { encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(expected);
      }
      const built = fileURLToPath(
        new URL("../dist/dependabot-cli.mjs", import.meta.url),
      );
      const result = spawnSync("node", [built], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(await readFile(join(root, ".github/dependabot.yml"), "utf8")).toBe(
        expected,
      );
    });
  },
);

test("preserves the existing yaml spelling and rejects conflicting outputs", async () => {
  await withRepository(async (root) => {
    await mkdir(join(root, ".github"));
    await writeFile(join(root, ".github/dependabot.yaml"), "version: 2\n");
    expect(invoke(root).status).toBe(0);
    await writeFile(join(root, ".github/dependabot.yml"), "sentinel\n");
    const result = invoke(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exactly one Dependabot configuration");
    expect(await readFile(join(root, ".github/dependabot.yml"), "utf8")).toBe(
      "sentinel\n",
    );
  });
});

test("help needs no repository and invalid options never write", async () => {
  const root = await mkdtemp(join(tmpdir(), "dependabot-help-"));
  try {
    const help = invoke(root, ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: stll-dependabot");
    for (const args of [["--write"], ["--help", "extra"]]) {
      const result = invoke(root, args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage:");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated configuration never overwrites linked external targets", async () => {
  for (const kind of ["parent", "symlink", "hard-link"]) {
    await withRepository(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "dependabot-outside-"));
      try {
        const sentinel = join(outside, "sentinel.yml");
        await writeFile(sentinel, "unchanged\n");
        if (kind === "parent")
          await symlink(outside, join(root, ".github"), "dir");
        else {
          await mkdir(join(root, ".github"));
          const destination = join(root, ".github/dependabot.yml");
          if (kind === "symlink") await symlink(sentinel, destination);
          else await link(sentinel, destination);
        }
        expect(invoke(root).status).toBe(1);
        expect(await readFile(sentinel, "utf8")).toBe("unchanged\n");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  }
});
