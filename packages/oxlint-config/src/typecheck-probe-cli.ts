#!/usr/bin/env node
import { runTypecheckProbe } from "./typecheck-probe";
import { parseProbeArguments, probeUsage } from "./typecheck-probe-args";

const main = async () => {
  const args = parseProbeArguments(process.argv.slice(2));
  if (args.mode === "help") {
    process.stdout.write(`${probeUsage}\n`);
    return;
  }
  await runTypecheckProbe({
    repo: process.cwd(),
    project: args.project,
    command: args.command,
    seedDirectory: args.seedDirectory,
    output: (text) => process.stdout.write(text),
  });
  process.stdout.write(
    "typecheck probe passed: seeded TS2322 detected and clean typecheck passed\n",
  );
};

main().catch((error: unknown) => {
  process.stderr.write(
    `typecheck-probe: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
