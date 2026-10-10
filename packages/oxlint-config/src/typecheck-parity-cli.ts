#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { runTypecheckParity } from "./typecheck-parity";

const main = async () => {
  if (process.argv.slice(2).length > 0)
    throw new Error("Usage: stll-typecheck-parity (run from repository root)");
  const policy: unknown = JSON.parse(
    await readFile(new URL("../toolchain.json", import.meta.url), "utf8"),
  );
  if (!(await runTypecheckParity({ repo: process.cwd(), policy })))
    process.exitCode = 1;
};

main().catch((error: unknown) => {
  process.stderr.write(
    `typecheck-parity: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
