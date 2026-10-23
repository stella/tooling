#!/usr/bin/env node
import { assembleReleasePlan } from "@changesets/assemble-release-plan";
import { readConfig } from "@changesets/config";
import { readChangesets } from "@changesets/read";
import { getPackagesSync, type Package } from "@manypkg/get-packages";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { checkEngineSupport, type EnginePackage } from "./engine-support";

const MAX_MANIFEST_BUFFER = 100 * 1024 * 1024;

const git = (root: string, args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_MANIFEST_BUFFER,
  });

const parseBase = (args: string[]) => {
  if (args.length === 1 && args.at(0) === "--help") return undefined;
  if (args.length === 2 && args.at(0) === "--base" && args.at(1) !== "")
    return args.at(1);
  throw new Error("Usage: stll-engine-support --base <git ref>");
};

const packageNodeRange = ({ packageJson }: Package) => {
  const engines = "engines" in packageJson ? packageJson.engines : undefined;
  return typeof engines === "object" &&
    engines !== null &&
    "node" in engines &&
    typeof engines.node === "string"
    ? engines.node
    : undefined;
};

const publishedPackages = (packages: Package[], ignored: Set<string>) => {
  const collected = new Map<string, EnginePackage>();
  for (const pkg of packages) {
    const { name, private: isPrivate } = pkg.packageJson;
    if (isPrivate === true || typeof name !== "string") continue;
    if (collected.has(name))
      throw new Error(`Duplicate published package name: ${name}`);
    const node = packageNodeRange(pkg);
    collected.set(name, {
      name,
      ...(node === undefined ? {} : { node }),
      changesetsManaged: !ignored.has(name),
    });
  }
  return collected;
};

const basePackage = (root: string, base: string, pkg: Package) => {
  const relativeManifest = path
    .relative(root, path.join(pkg.dir, "package.json"))
    .split(path.sep)
    .join(path.posix.sep);
  if (
    git(root, [
      "ls-tree",
      "--name-only",
      base,
      "--",
      relativeManifest,
    ]).trim() === ""
  )
    return undefined;
  const packageJson = JSON.parse(
    git(root, ["show", `${base}:${relativeManifest}`]),
  );
  if (typeof packageJson !== "object" || packageJson === null)
    throw new Error(`Invalid package manifest at ${base}:${relativeManifest}`);
  return { ...pkg, packageJson };
};

const main = async () => {
  const base = parseBase(process.argv.slice(2));
  if (base === undefined) {
    process.stdout.write("Usage: stll-engine-support --base <git ref>\n");
    return;
  }
  const root = process.cwd();
  git(root, ["cat-file", "-e", `${base}^{commit}`]);
  const workspace = getPackagesSync(root);
  const discovered = workspace.packages;
  const configResult = await readConfig(root, workspace);
  if (configResult.errors !== undefined)
    throw new Error(configResult.errors.join("\n"));
  const config = configResult.config;
  const ignored = new Set(config.ignore);
  const releasePlan = assembleReleasePlan(
    await readChangesets(root),
    workspace,
    config,
    undefined,
  );
  const basePackages = discovered.flatMap((pkg) => {
    const found = basePackage(root, base, pkg);
    return found === undefined ? [] : [found];
  });
  const failures = checkEngineSupport({
    base: publishedPackages(basePackages, ignored),
    head: publishedPackages(discovered, ignored),
    majorReleases: new Set(
      releasePlan.releases
        .filter(({ type }) => type === "major")
        .map(({ name }) => name),
    ),
  });
  for (const failure of failures)
    process.stderr.write(
      `[engine-support] ${failure.packageName} narrows Node support from ${failure.baseRange} to ${failure.headRange}; ${failure.packageName} requires a pending major changeset\n`,
    );
  if (failures.length > 0) process.exitCode = 1;
};

void main().catch((error: unknown) => {
  process.stderr.write(
    `engine-support: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
