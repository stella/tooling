#!/usr/bin/env node
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { resolveExpiryScope } from "./dated-entry-scope";
import {
  checkGeneratedOutput,
  generationDiagnostics,
  writeGeneratedFile,
} from "./generated-file";
import {
  checkRepositoryQuarantine,
  pruneRepositoryQuarantine,
  synchronizeRepositoryQuarantine,
} from "./quarantine-policy";
import { readToolchainInputs } from "./toolchain-guard";

const usage =
  "Usage: stll-quarantine [--check | --sync | --prune]\nRun from the repository root; --check is the default.";
const main = async () => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args.at(0) === "--help") {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const mode = args.at(0) ?? "--check";
  if (args.length > 1 || !["--check", "--sync", "--prune"].includes(mode))
    throw new Error(usage);
  const root = await realpath(process.cwd());
  const { files, trackedFiles, diagnostics } = readToolchainInputs(root, {
    bunLock: "content",
  });
  const destination = join(root, "bunfig.toml");
  // These root inputs may be new outputs not yet staged in Git.
  for (const file of ["bunfig.toml", "bun.lock"]) {
    const source = join(root, file);
    if ((await checkGeneratedOutput(source)) !== undefined)
      files[file] = await readFile(source, "utf8");
  }
  const remaining = await generationDiagnostics({
    diagnostics,
    outputs: [{ relative: "bunfig.toml", destination }],
  });
  if (remaining.length > 0)
    throw new Error(
      remaining.map(({ path, message }) => `${path}: ${message}`).join("\n"),
    );
  if (mode === "--check") {
    const npmrc = await lstat(join(root, ".npmrc")).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    });
    const result = checkRepositoryQuarantine({
      files,
      npmrcPresent: npmrc !== undefined || trackedFiles.has(".npmrc"),
      expiry: resolveExpiryScope(root),
    });
    for (const warning of result.warnings)
      process.stderr.write(`warning: ${warning}\n`);
    if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
    process.stdout.write("Verified bunfig.toml quarantine policy\n");
    return;
  }
  const text =
    mode === "--sync"
      ? synchronizeRepositoryQuarantine({ files })
      : pruneRepositoryQuarantine({ files }).bunfig;
  const stat = await checkGeneratedOutput(destination);
  if (text !== files["bunfig.toml"])
    await writeGeneratedFile({
      destination,
      text,
      mode: stat === undefined ? 0o644 : stat.mode & 0o777,
    });
  process.stdout.write(
    `${mode === "--sync" ? "Synchronized" : "Pruned"} bunfig.toml quarantine policy\n`,
  );
};
main().catch((error: unknown) => {
  process.stderr.write(
    `quarantine: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
