#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { checkToolchain } from "./toolchain-guard";
import { parseToolchainPolicy } from "./toolchain-schema";

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "Usage: stll-toolchain-check (opt-outs: tracked stll-toolchain.json)\n",
    );
    process.exit(0);
  }
  if (args.length !== 0) throw new Error(`unexpected argument: ${args.at(0)}`);
  const policy = parseToolchainPolicy(
    JSON.parse(
      readFileSync(new URL("../toolchain.json", import.meta.url), "utf8"),
    ),
  );
  const diagnostics = checkToolchain({ root: process.cwd(), policy });
  for (const diagnostic of diagnostics)
    process.stderr.write(
      `${diagnostic.path}:${diagnostic.line}: [${diagnostic.rule}] ${diagnostic.message}\n`,
    );
  if (diagnostics.length > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    `toolchain-check:1: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
