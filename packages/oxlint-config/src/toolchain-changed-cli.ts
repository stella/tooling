#!/usr/bin/env node
import { detectToolchainChanges } from "./toolchain-changed";
import { changedUsage, parseChangedArguments } from "./toolchain-changed-args";

const main = async () => {
  const args = parseChangedArguments(process.argv.slice(2));
  if (args.mode === "help") {
    process.stdout.write(`${changedUsage}\n`);
    return;
  }
  // Unreadable history is a successful, fail-safe changed=true detector result.
  process.stdout.write(
    `${JSON.stringify(await detectToolchainChanges({ repo: process.cwd(), since: args.since }))}\n`,
  );
};

main().catch((error: unknown) => {
  process.stderr.write(
    `toolchain-changed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
