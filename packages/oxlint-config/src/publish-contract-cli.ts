#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { parseDocument } from "yaml";

import { resolvePublishBuildTarget } from "./publish-build-target";
import {
  checkPublishContract,
  resolveManifestContract,
} from "./publish-contract";
import { parseToolchainPolicy } from "./toolchain-schema";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const root = process.cwd();
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args.at(0) === "--help") {
    process.stdout.write("Usage: stll-publish-contract [--write]\n");
  } else {
    if (args.length > 1 || (args.length === 1 && args.at(0) !== "--write"))
      throw new Error("Expected no arguments or --write");
    const write = args.at(0) === "--write";
    const policy = parseToolchainPolicy(
      JSON.parse(
        readFileSync(new URL("../toolchain.json", import.meta.url), "utf8"),
      ),
    );
    const consumer = {
      node: policy.consumerNode,
      typescript: policy.consumerTypescript,
    };
    const rootManifest: unknown = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    );
    if (!record(rootManifest))
      throw new Error("Root package manifest must be an object");
    let patterns: unknown = rootManifest["workspaces"];
    if (record(patterns)) patterns = patterns["packages"];
    const pnpm = path.join(root, "pnpm-workspace.yaml");
    if (existsSync(pnpm)) {
      const document = parseDocument(readFileSync(pnpm, "utf8"));
      if (document.errors.length > 0)
        throw new Error("Invalid pnpm workspace configuration");
      const workspace: unknown = document.toJS({ maxAliasCount: 100 });
      if (!record(workspace))
        throw new Error("Invalid pnpm workspace configuration");
      patterns = workspace["packages"];
    }
    if (
      patterns !== undefined &&
      (!Array.isArray(patterns) ||
        !patterns.every((item: unknown) => typeof item === "string"))
    )
      throw new Error("Workspace packages must be string patterns");
    const declared: string[] = Array.isArray(patterns) ? patterns : [];
    const positive = declared.filter((item) => !item.startsWith("!"));
    const negative = declared
      .filter((item) => item.startsWith("!"))
      .map((item) => item.slice(1));
    const included =
      positive.length > 0 ? picomatch(positive, { dot: true }) : () => false;
    const excluded =
      negative.length > 0 ? picomatch(negative, { dot: true }) : () => false;
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
    }).split("\0");
    const manifests = tracked.filter(
      (file) =>
        file === "package.json" ||
        (file.endsWith("/package.json") &&
          included(path.posix.dirname(file)) &&
          !excluded(path.posix.dirname(file))),
    );
    let checked = 0;
    for (const file of manifests.sort()) {
      const manifest: unknown = JSON.parse(
        readFileSync(path.join(root, file), "utf8"),
      );
      if (!record(manifest))
        throw new Error(`${file}: manifest must be an object`);
      if (manifest["private"] === true) continue;
      if (typeof manifest["name"] !== "string")
        throw new Error(`${file}: published package needs a name`);
      checked++;
      const directory = path.dirname(path.join(root, file));
      const contractFile = path.join(directory, "publish-contract.json");
      const target = await resolvePublishBuildTarget(directory);
      const current = resolveManifestContract({ manifest, target });
      const committed: unknown = write
        ? current
        : JSON.parse(readFileSync(contractFile, "utf8"));
      const diagnostics = checkPublishContract({
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
      if (write)
        writeFileSync(contractFile, `${JSON.stringify(current, null, 2)}\n`);
    }
    if (checked === 0) throw new Error("No published workspace packages found");
  }
} catch (error) {
  process.stderr.write(
    `publish-contract:1: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
