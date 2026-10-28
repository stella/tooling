#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { resolveExpiryScope } from "./dated-entry-scope";
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
  const diagnostics = checkToolchain({
    root: process.cwd(),
    policy,
    expiryScope: resolveExpiryScope(process.cwd()),
    onWarning: ({ path, line, rule, message }) =>
      process.stderr.write(`${path}:${line}: [${rule}] warning: ${message}\n`),
    onDelegated: ({ path, line, tool, selector, ref }) =>
      process.stdout.write(
        tool === "action"
          ? `${path}:${line}: [runtime-delegated] local action ${selector} delegates source validation to checkout ref ${ref}\n`
          : `${path}:${line}: [runtime-delegated] setup-${tool} ${selector} delegates its version to checkout ref ${ref}\n`,
      ),
  });
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
