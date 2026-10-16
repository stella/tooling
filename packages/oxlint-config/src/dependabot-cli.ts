#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  checkGeneratedOutput,
  generationDiagnostics,
  writeGeneratedFile,
} from "./generated-file";
import { generateDependabotConfig } from "./toolchain-dependabot";
import { readToolchainInputs } from "./toolchain-guard";
import { parseToolchainPolicy } from "./toolchain-schema";

const usage =
  "Usage: stll-dependabot (run from repository root)\n       stll-dependabot --help";
const main = async () => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args.at(0) === "--help") {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (args.length !== 0) throw new Error(usage);
  const root = await realpath(process.cwd());
  const { files, trackedFiles, diagnostics } = readToolchainInputs(root);
  const policy = parseToolchainPolicy(
    JSON.parse(
      await readFile(new URL("../toolchain.json", import.meta.url), "utf8"),
    ),
  );
  const yaml = join(root, ".github/dependabot.yaml");
  const yml = join(root, ".github/dependabot.yml");
  const yamlStat = await checkGeneratedOutput(yaml);
  const ymlStat = await checkGeneratedOutput(yml);
  const candidates = [
    { relative: ".github/dependabot.yaml", path: yaml, stat: yamlStat },
    { relative: ".github/dependabot.yml", path: yml, stat: ymlStat },
  ].filter(
    ({ relative, stat }) => stat !== undefined || trackedFiles.has(relative),
  );
  if (candidates.length > 1)
    throw new Error("keep exactly one Dependabot configuration: .yml or .yaml");
  const selected = candidates.at(0) ?? {
    relative: ".github/dependabot.yml",
    path: yml,
    stat: ymlStat,
  };
  const remainingDiagnostics = await generationDiagnostics({
    diagnostics,
    outputs: [{ relative: selected.relative, destination: selected.path }],
  });
  if (remainingDiagnostics.length !== 0)
    throw new Error(
      remainingDiagnostics
        .map(({ path, message }) => `${path}: ${message}`)
        .join("\n"),
    );
  const destination = selected.path;
  const mode = selected.stat?.mode;
  await writeGeneratedFile({
    destination,
    text: generateDependabotConfig({ files, policy: policy.dependabot }),
    mode: mode === undefined ? 0o644 : mode & 0o777,
  });
  process.stdout.write(`Generated ${selected.relative}\n`);
};

main().catch((error: unknown) => {
  process.stderr.write(
    `dependabot: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
