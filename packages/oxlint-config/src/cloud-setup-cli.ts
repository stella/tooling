#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { cloudSetupPath, generateCloudSetup } from "./cloud-setup";
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
      diagnostics.map(({ path, message }) => `${path}: ${message}`).join("\n"),
    );
  const text = files["stll-toolchain.json"];
  if (text === undefined)
    throw new Error("requires tracked stll-toolchain.json");
  const { cloud } = parseToolchainConfiguration(JSON.parse(text));
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
  });
  const destination = join(root, cloudSetupPath);
  const parent = dirname(destination);
  const parentStat = await optionalStat(parent);
  if (parentStat === undefined) await mkdir(parent);
  else if (parentStat.isSymbolicLink() || !parentStat.isDirectory())
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
  const output = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o755,
  );
  try {
    const opened = await output.stat();
    if (!opened.isFile() || opened.nlink !== 1)
      throw new Error(
        "cloud setup destination must be a single-link regular repository file",
      );
    await output.truncate(0);
    await output.writeFile(script, "utf8");
    await output.chmod(0o755);
  } finally {
    await output.close();
  }
  process.stdout.write(`Generated ${cloudSetupPath}\n`);
};

main().catch((error: unknown) => {
  process.stderr.write(
    `cloud-setup: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
