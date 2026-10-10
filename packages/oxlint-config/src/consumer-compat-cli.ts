#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { runConsumerCompat } from "./consumer-compat";
import {
  consumerCompatUsage,
  parseConsumerCompatArguments,
} from "./consumer-compat-arguments";

const main = async () => {
  const argumentsResult = parseConsumerCompatArguments(process.argv.slice(2));
  if (argumentsResult.mode === "help") {
    process.stdout.write(`${consumerCompatUsage}\n`);
    return;
  }
  const policy: unknown = JSON.parse(
    await readFile(new URL("../toolchain.json", import.meta.url), "utf8"),
  );
  await runConsumerCompat({
    root: process.cwd(),
    packages: argumentsResult.packages,
    consumerNode: argumentsResult.consumerNode,
    fixturePath: argumentsResult.fixturePath,
    policy,
  });
};

main().catch((error: unknown) => {
  process.stderr.write(
    `consumer-compat: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
