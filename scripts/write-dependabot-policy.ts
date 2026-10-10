#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { generateDependabotConfig } from "../packages/oxlint-config/src/toolchain-dependabot";
import { parseToolchainPolicy } from "../packages/oxlint-config/src/toolchain-schema";
import toolchain from "../packages/oxlint-config/toolchain.json";

const root = path.resolve(import.meta.dir, "..");
const files: Record<string, string> = {};
for (const file of execFileSync("git", ["ls-files", "-z", "--cached"], {
  cwd: root,
  encoding: "utf8",
}).split("\0")) {
  if (
    !/(?:^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|requirements[^/]*\.txt)$/.test(
      file,
    ) &&
    !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)
  )
    continue;
  files[file] = readFileSync(path.join(root, file), "utf8");
}
writeFileSync(
  path.join(root, ".github/dependabot.yml"),
  generateDependabotConfig({
    files,
    policy: parseToolchainPolicy(toolchain).dependabot,
  }),
);
