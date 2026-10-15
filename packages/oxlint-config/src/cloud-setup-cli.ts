#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { cloudSetupPath, generateCloudSetup } from "./cloud-setup";
import {
  cloudClaudeSettingsPath,
  cloudSessionStartFix,
  mergeCloudSessionStartHook,
} from "./cloud-setup-claude";
import {
  parseToolchainConfiguration,
  readToolchainInputs,
} from "./toolchain-guard";
import { parseToolchainPolicy } from "./toolchain-schema";

const usage =
  "Usage: stll-cloud-setup (run from repository root)\n       stll-cloud-setup --help";
const optionalStat = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
};

const checkOutput = async (destination: string) => {
  const parent = dirname(destination);
  const parentStat = await optionalStat(parent);
  if (
    parentStat !== undefined &&
    (parentStat.isSymbolicLink() || !parentStat.isDirectory())
  )
    throw new Error("cloud setup parent must be a real repository directory");
  const destinationStat = await optionalStat(destination);
  if (
    destinationStat !== undefined &&
    (destinationStat.isSymbolicLink() ||
      !destinationStat.isFile() ||
      destinationStat.nlink !== 1)
  )
    throw new Error(
      "cloud setup destination must be a single-link regular repository file",
    );
  return destinationStat;
};

type WriteOutputOptions = {
  destination: string;
  text: string;
  mode: number;
};

const writeOutput = async ({ destination, text, mode }: WriteOutputOptions) => {
  await checkOutput(destination);
  await mkdir(dirname(destination), { recursive: true });
  const output = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    mode,
  );
  try {
    const opened = await output.stat();
    if (!opened.isFile() || opened.nlink !== 1)
      throw new Error(
        "cloud setup destination must be a single-link regular repository file",
      );
    await output.truncate(0);
    await output.writeFile(text, "utf8");
    await output.chmod(mode);
  } finally {
    await output.close();
  }
};

const readClaudeSettings = async (destination: string) => {
  try {
    if ((await checkOutput(destination)) === undefined) return undefined;
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
  if (diagnostics.length > 0)
    throw new Error(
      diagnostics
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
  const destination = join(root, cloudSetupPath);
  await checkOutput(destination);
  const settingsDestination = join(root, cloudClaudeSettingsPath);
  const settings = await readClaudeSettings(settingsDestination);
  const mergedSettings = mergeCloudSessionStartHook(settings?.text);
  await writeOutput({ destination, text: script, mode: 0o755 });
  if (mergedSettings !== settings?.text)
    await writeOutput({
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
