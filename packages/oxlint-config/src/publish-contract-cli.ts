#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { discoverConsumerManifests } from "./consumer-compat-config";
import { resolvePublishBuildTarget } from "./publish-build-target";
import {
  checkPublishContract,
  resolveManifestContract,
} from "./publish-contract";
import { parseToolchainPolicy } from "./toolchain-schema";

const root = process.cwd();
const main = async () => {
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
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
    }).split("\0");
    const files: Record<string, string> = {};
    for (const file of tracked) {
      if (
        file
          .split("/")
          .some((part) => part === "node_modules" || part === ".git") ||
        !["package.json", "pnpm-workspace.yaml"].includes(
          path.posix.basename(file),
        )
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
      if (typeof manifest["name"] !== "string" || manifest["name"] === "")
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
};

main().catch((error: unknown) => {
  process.stderr.write(
    `publish-contract:1: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
