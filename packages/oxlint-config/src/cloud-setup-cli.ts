#!/usr/bin/env node
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { cloudSetupPath, generateCloudSetup } from "./cloud-setup";
import {
  cloudClaudeSettingsPath,
  cloudSessionStartFix,
  mergeCloudClaudeSettings,
} from "./cloud-setup-claude";
import {
  checkGeneratedOutput,
  generationDiagnostics,
  writeGeneratedFile,
} from "./generated-file";
import {
  parseToolchainConfiguration,
  readToolchainInputs,
} from "./toolchain-guard";
import { parseToolchainPolicy } from "./toolchain-schema";

const usage =
  "Usage: stll-cloud-setup (run from repository root)\n       stll-cloud-setup --help";
const readClaudeSettings = async (destination: string) => {
  try {
    if ((await checkGeneratedOutput(destination)) === undefined)
      return undefined;
    const input = await open(
      destination,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await input.stat();
      if (!opened.isFile() || opened.nlink !== 1)
        throw new Error(
          "settings must be a single-link regular repository file",
        );
      return { text: await input.readFile("utf8"), mode: opened.mode & 0o777 };
    } finally {
      await input.close();
    }
  } catch (error) {
    throw new Error(
      `cannot safely merge ${cloudClaudeSettingsPath}: ${error instanceof Error ? error.message : String(error)}; ${cloudSessionStartFix}`,
    );
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args.at(0) === "--help") {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (args.length !== 0) throw new Error(usage);
  const root = await realpath(process.cwd());
  const { files, diagnostics } = readToolchainInputs(root);
  const destination = join(root, cloudSetupPath);
  const settingsDestination = join(root, cloudClaudeSettingsPath);
  // Validate settings separately to retain actionable merge diagnostics.
  const settings = await readClaudeSettings(settingsDestination);
  const remainingDiagnostics = await generationDiagnostics({
    diagnostics,
    outputs: [
      { relative: cloudSetupPath, destination },
      { relative: cloudClaudeSettingsPath, destination: settingsDestination },
    ],
  });
  if (remainingDiagnostics.length > 0)
    throw new Error(
      remainingDiagnostics
        .map(
          ({ path, message }) =>
            `${path}: ${message}${path === cloudClaudeSettingsPath ? `; ${cloudSessionStartFix}` : ""}`,
        )
        .join("\n"),
    );
  const text = files["stll-toolchain.json"];
  if (text === undefined)
    throw new Error("requires tracked stll-toolchain.json");
  const { cloud, rustExceptions } = parseToolchainConfiguration(
    JSON.parse(text),
  );
  if (cloud === undefined)
    throw new Error("requires an explicit cloud declaration");
  const nodeVersion = files[".node-version"];
  if (nodeVersion === undefined)
    throw new Error("requires tracked root .node-version");
  const policy = parseToolchainPolicy(
    JSON.parse(
      await readFile(new URL("../toolchain.json", import.meta.url), "utf8"),
    ),
  );
  const script = generateCloudSetup({
    policy,
    cloud,
    nodeVersion: nodeVersion.trim(),
    files,
    rustExceptions,
  });
  const mergedSettings = mergeCloudClaudeSettings(settings?.text);
  await writeGeneratedFile({ destination, text: script, mode: 0o755 });
  if (mergedSettings !== settings?.text)
    await writeGeneratedFile({
      destination: settingsDestination,
      text: mergedSettings,
      mode: settings?.mode ?? 0o644,
    });
  process.stdout.write(
    `Generated ${cloudSetupPath} and ${cloudClaudeSettingsPath}\n`,
  );
};

main().catch((error: unknown) => {
  process.stderr.write(
    `cloud-setup: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
