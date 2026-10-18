import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import toolchain from "../toolchain.json";
import {
  checkToolchain,
  parseToolchainConfiguration,
  readToolchainInputs,
} from "./toolchain-guard";
import { parseToolchainPolicy } from "./toolchain-schema";

const policy = parseToolchainPolicy(toolchain);
const now = new Date("2026-10-17T00:00:00.000Z");

test("tracked quarantine input warns 48 hours before expiry without failing, then reports overdue exclusions", () => {
  const root = mkdtempSync(join(tmpdir(), "stll-quarantine-guard-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { "@stll/oxlint-config": "1.4.0" } }),
    );
    writeFileSync(
      join(root, "bun.lock"),
      JSON.stringify({
        packages: {
          "@stll/oxlint-config": ["@stll/oxlint-config@1.4.0", "", {}],
          "@stll/native": ["@stll/native-linux-x64@1.0.0", "", {}],
        },
      }),
    );
    const bunfig = `[install]\nminimumReleaseAge = 432000\nminimumReleaseAgeExcludes = [\n  "@stll/oxlint-config",\n  "@stll/native-linux-x64",\n  "bun-types", # quarantine-expires: 2026-10-19T00:00:00.000Z\n]\n`;
    writeFileSync(join(root, "bunfig.toml"), bunfig);
    execFileSync("git", ["add", "."], { cwd: root });
    expect(readToolchainInputs(root).files["bun.lock"]).toBe("");
    expect(
      readToolchainInputs(root, { bunLock: "content" }).files["bun.lock"],
    ).toContain("@stll/native-linux-x64");
    const warnings: string[] = [];
    const diagnostics = checkToolchain({
      root,
      policy,
      now,
      onWarning: ({ rule, message }) => warnings.push(`${rule}: ${message}`),
    });
    expect(
      diagnostics.filter(({ rule }) => rule === "quarantine-policy"),
    ).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings.at(0)).toContain("2026-10-19T00:00:00.000Z");
    expect(
      checkToolchain({
        root,
        policy,
        now: new Date("2026-10-20T00:00:00.000Z"),
      }).some(
        ({ rule, message }) =>
          rule === "quarantine-policy" && message.includes("expired"),
      ),
    ).toBe(true);
    writeFileSync(
      join(root, "bunfig.toml"),
      bunfig.replace('  "@stll/native-linux-x64",\n', ""),
    );
    expect(
      checkToolchain({ root, policy, now }).some(
        ({ rule, message }) =>
          rule === "quarantine-policy" &&
          message.includes("@stll/native-linux-x64"),
      ),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quarantine policy cannot be opted out", () => {
  expect(() =>
    parseToolchainConfiguration({
      optOuts: [{ rule: "quarantine-policy", reason: "fixture" }],
    }),
  ).toThrow("cannot be opted out");
});
