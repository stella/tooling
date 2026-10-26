import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import policyInput from "../toolchain.json";
import {
  checkDependabot,
  generateDependabotConfig,
} from "./toolchain-dependabot";
import { readToolchainInputs } from "./toolchain-guard";
import { parseToolchainPolicy } from "./toolchain-schema";

test("generation and policy checks omit deleted tracked Bundler and Composer declarations", () => {
  const root = mkdtempSync(join(tmpdir(), "dependabot-deleted-inputs-"));
  const policy = parseToolchainPolicy(policyInput).dependabot;
  const cli = fileURLToPath(new URL("./dependabot-cli.ts", import.meta.url));
  try {
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, "oracle"));
    writeFileSync(
      join(root, "oracle/Gemfile"),
      "source 'https://rubygems.org'\n",
    );
    writeFileSync(join(root, "oracle/composer.json"), "{}\n");
    execFileSync("git", ["add", "."], { cwd: root });
    const initial = generateDependabotConfig({
      files: readToolchainInputs(root).files,
      policy,
    });
    expect(initial).toContain("package-ecosystem: bundler");
    expect(initial).toContain("package-ecosystem: composer");
    for (const name of ["Gemfile", "composer.json"])
      rmSync(join(root, "oracle", name));
    const snapshot = readToolchainInputs(root);
    expect(snapshot.diagnostics).toEqual([]);
    const expected = generateDependabotConfig({
      files: snapshot.files,
      policy,
    });
    expect(expected).not.toContain("package-ecosystem: bundler");
    expect(expected).not.toContain("package-ecosystem: composer");
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync(process.execPath, [cli], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, ".github/dependabot.yml"), "utf8")).toBe(
        expected,
      );
    }
    execFileSync("git", ["add", ".github/dependabot.yml"], { cwd: root });
    expect(
      checkDependabot({ files: readToolchainInputs(root).files, policy }),
    ).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
