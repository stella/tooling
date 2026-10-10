#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { toolchainReleaseChangeset } from "./lib/toolchain-release-plan";

const root = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "toolchain-release-plan-"));
try {
  const output = join(scratch, "plan.json");
  execFileSync(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("@changesets/cli/bin.js")),
      "status",
      "--output",
      output,
    ],
    { cwd: root, stdio: "inherit" },
  );
  const changeset = toolchainReleaseChangeset({
    policyText: readFileSync(
      join(root, "packages/oxlint-config/toolchain.json"),
      "utf8",
    ),
    releasePlan: JSON.parse(readFileSync(output, "utf8")),
  });
  if (changeset !== undefined) {
    writeFileSync(join(root, ".changeset/toolchain-owned-pins.md"), changeset, {
      flag: "wx",
    });
    console.log("Added the toolchain policy package to the release plan.");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
