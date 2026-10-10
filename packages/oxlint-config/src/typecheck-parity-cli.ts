#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { runTypecheckParity } from "./typecheck-parity";
import { parityUsage, parseParityArguments } from "./typecheck-parity-args";
import { runSelectedTypecheckParity } from "./typecheck-parity-selection";

const main = async () => {
  const args = parseParityArguments(process.argv.slice(2));
  if (args.mode === "help") {
    process.stdout.write(`${parityUsage}\n`);
    return;
  }
  const policy: unknown = JSON.parse(
    await readFile(new URL("../toolchain.json", import.meta.url), "utf8"),
  );
  if (
    !(await runSelectedTypecheckParity({
      repo: process.cwd(),
      since: args.changedSince,
      run: () =>
        runTypecheckParity({
          repo: process.cwd(),
          policy,
          ...(args.mode === "selected" ? { projects: args.projects } : {}),
        }),
    }))
  )
    process.exitCode = 1;
};

main().catch((error: unknown) => {
  process.stderr.write(
    `typecheck-parity: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
