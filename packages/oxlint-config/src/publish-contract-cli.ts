#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  assertConsumerPublishableManifest,
  consumerRecord,
  discoverConsumerManifests,
} from "./consumer-compat-config";
import { resolveConsumerReleasePack } from "./consumer-release-pack";
import { readGitTrackedOutput } from "./git-tracked-output";
import { readPackedSyntaxFiles } from "./publish-artifact-syntax";
import { resolvePublishBuildTarget } from "./publish-build-target";
import {
  checkPublishContract,
  type PublishPacker,
  type PublishTarget,
  resolveManifestContract,
} from "./publish-contract";
import { githubAutomationFileKind } from "./toolchain-inputs";
import { parseToolchainPolicy } from "./toolchain-schema";

type Mode =
  | { type: "help" }
  | { type: "check" }
  | { type: "write" }
  | { type: "artifact"; archive: string };

const parseMode = (args: string[]): Mode => {
  if (args.length === 0) return { type: "check" };
  if (args.length === 1 && args.at(0) === "--help") return { type: "help" };
  if (args.length === 1 && args.at(0) === "--write") return { type: "write" };
  const archive = args.at(1);
  if (
    args.length === 2 &&
    args.at(0) === "--artifact" &&
    archive !== undefined &&
    archive !== "" &&
    !archive.startsWith("--")
  )
    return { type: "artifact", archive };
  throw new Error(
    "Expected no arguments, --write, or --artifact <archive.tgz>; artifact checking cannot be combined with --write",
  );
};

type PublicContext = {
  file: string;
  target: PublishTarget;
  packer: PublishPacker;
  contract: unknown;
};

const root = process.cwd();
const main = async () => {
  const mode = parseMode(process.argv.slice(2));
  if (mode.type === "help") {
    process.stdout.write(
      "Usage: stll-publish-contract [--write | --artifact <archive.tgz>]\n",
    );
  } else {
    const write = mode.type === "write";
    const contexts = new Map<string, PublicContext>();
    const policy = parseToolchainPolicy(
      JSON.parse(
        readFileSync(new URL("../toolchain.json", import.meta.url), "utf8"),
      ),
    );
    const consumer = {
      node: policy.consumerNode,
      typescript: policy.consumerTypescript,
    };
    const tracked = readGitTrackedOutput(root, "paths").split("\0");
    const files: Record<string, string> = {};
    for (const file of tracked) {
      if (
        file
          .split("/")
          .some((part) => part === "node_modules" || part === ".git") ||
        (!["package.json", "pnpm-workspace.yaml"].includes(
          path.posix.basename(file),
        ) &&
          githubAutomationFileKind(file) !== "workflow")
      )
        continue;
      files[file] = readFileSync(path.join(root, file), "utf8");
    }
    const manifests = discoverConsumerManifests(files);
    const names = new Set<string>();
    for (const manifest of manifests.values()) {
      const name = manifest["name"];
      if (typeof name !== "string" || name === "") continue;
      if (names.has(name))
        throw new Error(`duplicate workspace package: ${name}`);
      names.add(name);
    }
    let checked = 0;
    for (const [relative, manifest] of [...manifests].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const file = path.posix.join(relative, "package.json");
      if (manifest["private"] === true) continue;
      if (relative.split("/").includes("vendor"))
        throw new Error(
          `Published workspace packages under vendor directories are not supported by publish-contract: ${file}; move the package to a supported workspace directory`,
        );
      assertConsumerPublishableManifest({ manifest, directory: relative });
      checked++;
      const directory = path.dirname(path.join(root, file));
      const contractFile = path.join(directory, "publish-contract.json");
      const packer = resolveConsumerReleasePack(files).manager;
      const target = await resolvePublishBuildTarget(directory, packer);
      const current = resolveManifestContract({ manifest, target, packer });
      const committed: unknown = write
        ? current
        : JSON.parse(readFileSync(contractFile, "utf8"));
      const diagnostics = checkPublishContract({
        packer,
        manifest,
        target,
        contract: committed,
        policy: consumer,
      });
      for (const diagnostic of diagnostics)
        process.stderr.write(
          `${file}:1: [publish-contract] ${diagnostic.message}\n`,
        );
      if (diagnostics.length > 0) {
        process.exitCode = 1;
        continue;
      }
      const name = manifest["name"];
      if (typeof name !== "string")
        throw new Error(`Missing public package name: ${file}`);
      contexts.set(name, { file, target, packer, contract: committed });
      if (write)
        writeFileSync(contractFile, `${JSON.stringify(current, null, 2)}\n`);
    }
    if (checked === 0) throw new Error("No published workspace packages found");
    if (mode.type !== "artifact" || process.exitCode === 1) return;
    const packed = await readPackedSyntaxFiles(
      path.resolve(root, mode.archive),
    );
    const packedText = packed.get("package/package.json");
    if (packedText === undefined)
      throw new Error("Artifact has no package/package.json");
    const packedManifest: unknown = JSON.parse(packedText);
    if (
      !consumerRecord(packedManifest) ||
      typeof packedManifest["name"] !== "string" ||
      packedManifest["private"] === true
    )
      throw new Error(
        "Artifact must identify a declared public workspace package",
      );
    const name = packedManifest["name"];
    const context = contexts.get(name);
    if (context === undefined)
      throw new Error(
        `Artifact package is not a declared public workspace package: ${name}`,
      );
    assertConsumerPublishableManifest({
      manifest: packedManifest,
      directory: mode.archive,
    });
    const diagnostics = checkPublishContract({
      manifest: packedManifest,
      target: context.target,
      packer: context.packer,
      contract: context.contract,
      policy: consumer,
    });
    for (const diagnostic of diagnostics)
      process.stderr.write(
        `${mode.archive}:1: [publish-contract] ${diagnostic.message} (${context.file})\n`,
      );
    if (diagnostics.length > 0) process.exitCode = 1;
  }
};

main().catch((error: unknown) => {
  process.stderr.write(
    `publish-contract:1: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
