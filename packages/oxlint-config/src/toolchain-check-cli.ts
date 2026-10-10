#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { checkToolchain } from "./toolchain-check";

try {
  const allowNonBunPackageManagers: string[] = [];
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") {
      process.stdout.write(
        "Usage: stll-toolchain-check [--allow-non-bun-package-manager <tracked package.json path>]\n",
      );
      process.exit(0);
    }
    const value = args.at(index + 1);
    if (
      argument !== "--allow-non-bun-package-manager" ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(`unexpected or incomplete argument: ${argument}`);
    }
    allowNonBunPackageManagers.push(value);
    index += 1;
  }
  const toolchain: unknown = JSON.parse(
    readFileSync(new URL("../toolchain.json", import.meta.url), "utf8"),
  );
  if (
    typeof toolchain !== "object" ||
    toolchain === null ||
    !("bun" in toolchain) ||
    typeof toolchain.bun !== "string"
  ) {
    throw new Error("installed toolchain.json must define a Bun version");
  }
  const diagnostics = checkToolchain({
    root: process.cwd(),
    bunVersion: toolchain.bun,
    allowNonBunPackageManagers,
  });
  for (const diagnostic of diagnostics)
    process.stderr.write(
      `${diagnostic.path}:${diagnostic.line}: ${diagnostic.message}\n`,
    );
  if (diagnostics.length > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    `toolchain-check:1: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
