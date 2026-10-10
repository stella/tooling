#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import path from "node:path";

import { generateDependabotConfig } from "../packages/oxlint-config/src/toolchain-dependabot";
import { readToolchainInputs } from "../packages/oxlint-config/src/toolchain-guard";
import { parseToolchainPolicy } from "../packages/oxlint-config/src/toolchain-schema";
import toolchain from "../packages/oxlint-config/toolchain.json";

const root = path.resolve(import.meta.dir, "..");
const { files, diagnostics } = readToolchainInputs(root);
if (diagnostics.length > 0)
  throw new Error(
    diagnostics
      .map(({ path: file, line, message }) => `${file}:${line}: ${message}`)
      .join("\n"),
  );
writeFileSync(
  path.join(root, ".github/dependabot.yml"),
  generateDependabotConfig({
    files,
    policy: parseToolchainPolicy(toolchain).dependabot,
  }),
);
