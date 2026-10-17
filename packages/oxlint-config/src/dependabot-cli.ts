#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  generateDependabotConfig,
  parseDependabotInput,
  parseToolchainPolicy,
} from "./dependabot";
import {
  checkGeneratedOutput,
  generationDiagnostics,
  writeGeneratedFile,
} from "./generated-file";
import { readToolchainInputs } from "./toolchain-guard";

const usage =
  "Usage: stll-dependabot [--check] [--config <path>] (run from repository root)\n       stll-dependabot --help";
const main = async () => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args.at(0) === "--help") {
    process.stdout.write(`${usage}\n`);
    return;
  }
  let mode: "write" | "check" = "write";
  let config: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--check" && mode === "write") {
      mode = "check";
      continue;
    }
    if (arg === "--config" && config === undefined) {
      const next = args.at(index + 1);
      if (next === undefined || next.startsWith("--")) throw new Error(usage);
      config = next;
      index++;
      continue;
    }
    throw new Error(usage);
  }
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
  const declarations =
    config === undefined
      ? undefined
      : parseDependabotInput(
          JSON.parse(await readFile(resolve(root, config), "utf8")),
        );
  const text = generateDependabotConfig({
    files,
    policy: policy.dependabot,
    updates: declarations,
  });
  const destination = selected.path;
  if (mode === "check") {
    if (
      selected.stat === undefined ||
      (await readFile(destination, "utf8")) !== text
    )
      throw new Error(
        `${selected.relative} has drifted; run stll-dependabot${config === undefined ? "" : ` --config ${config}`}`,
      );
    process.stdout.write(`Verified ${selected.relative}\n`);
    return;
  }
  const permissions = selected.stat?.mode;
  await writeGeneratedFile({
    destination,
    text,
    mode: permissions === undefined ? 0o644 : permissions & 0o777,
  });
  process.stdout.write(`Generated ${selected.relative}\n`);
};

main().catch((error: unknown) => {
  process.stderr.write(
    `dependabot: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
