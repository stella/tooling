/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const packageJson = (properties: Record<string, unknown>) =>
  JSON.stringify(properties, null, 2);

describe("consumer toolchain guard CLI", () => {
  test("CLI returns success, diagnostic failure, help, and argument failure", () => {
    const root = mkdtempSync(path.join(tmpdir(), "stll-toolchain-cli-"));
    const entry = path.resolve(import.meta.dir, "toolchain-check-cli.ts");
    try {
      execFileSync("git", ["init", "-q", root]);
      writeFileSync(
        path.join(root, "package.json"),
        packageJson({ packageManager: "bun@1.4.3" }),
      );
      writeFileSync(
        path.join(root, "stll-toolchain.json"),
        packageJson({
          optOuts: [
            {
              rule: "dependabot-policy",
              reason: "CLI fixture has no dependency updates",
            },
          ],
        }),
      );
      execFileSync("git", ["add", "."], { cwd: root });
      const run = (args: string[]) =>
        spawnSync(process.execPath, [entry, ...args], {
          cwd: root,
          encoding: "utf8",
        });
      const passing = run([]);
      expect(passing.status).toBe(0);
      expect(passing.stderr).toBe("");
      writeFileSync(
        path.join(root, "package.json"),
        packageJson({ packageManager: "bun@1.4.1" }),
      );
      const failing = run([]);
      expect(failing.status).toBe(1);
      expect(failing.stderr).toContain(
        "package.json:2: [bun-pins] packageManager Bun version must be 1.4.3",
      );
      const help = run(["--help"]);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("Usage: stll-toolchain-check");
      for (const args of [["--unknown"], ["--allow-non-bun-package-manager"]]) {
        const invalid = run(args);
        expect(invalid.status).toBe(1);
        expect(invalid.stderr).toContain(
          "toolchain-check:1: unexpected argument",
        );
      }
      writeFileSync(
        path.join(root, "package.json"),
        packageJson({ packageManager: "npm@10.0.0" }),
      );
      writeFileSync(
        path.join(root, "stll-toolchain.json"),
        packageJson({
          optOuts: [
            { rule: "bun-pins", reason: "This fixture uses npm" },
            {
              rule: "dependabot-policy",
              reason: "CLI fixture has no dependency updates",
            },
          ],
        }),
      );
      expect(run([]).status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
