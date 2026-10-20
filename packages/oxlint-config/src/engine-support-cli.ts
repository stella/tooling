#!/usr/bin/env node
import parseChangeset from "@changesets/parse";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";

import { checkEngineSupport, type EnginePackage } from "./engine-support";

type Manifest = {
  name?: unknown;
  private?: unknown;
  workspaces?: unknown;
  engines?: unknown;
  optionalDependencies?: unknown;
};

const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });

const parseBase = (args: string[]) => {
  if (args.length === 1 && args.at(0) === "--help") return undefined;
  if (args.length === 2 && args.at(0) === "--base" && args.at(1) !== "")
    return args.at(1);
  throw new Error("Usage: stll-engine-support --base <git ref>");
};

const manifestFiles = (root: string, base?: string) => {
  if (base !== undefined)
    return git(root, ["ls-tree", "-r", "--name-only", base, "--"])
      .split("\n")
      .filter((file) => path.posix.basename(file) === "package.json");
  return git(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "**/package.json",
    "package.json",
  ])
    .split("\n")
    .filter((file) => file !== "" && existsSync(path.join(root, file)));
};

const readManifest = (root: string, file: string, base?: string): Manifest => {
  const source =
    base === undefined
      ? readFileSync(path.join(root, file), "utf8")
      : git(root, ["show", `${base}:${file}`]);
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Invalid package manifest: ${file}`);
  return value;
};

const workspacePatterns = (manifest: Manifest) => {
  const workspaces = manifest.workspaces;
  if (Array.isArray(workspaces))
    return workspaces.filter(
      (item): item is string => typeof item === "string",
    );
  if (
    typeof workspaces === "object" &&
    workspaces !== null &&
    "packages" in workspaces &&
    Array.isArray(workspaces.packages)
  )
    return workspaces.packages.filter(
      (item): item is string => typeof item === "string",
    );
  return [];
};

const collectPackages = (root: string, base?: string) => {
  const files = manifestFiles(root, base);
  const rootManifest = files.includes("package.json")
    ? readManifest(root, "package.json", base)
    : {};
  const patterns = workspacePatterns(rootManifest);
  const ignored = new Set<string>();
  const configFile = ".changeset/config.json";
  if (base === undefined) {
    const config: unknown = JSON.parse(
      readFileSync(path.join(root, configFile), "utf8"),
    );
    if (typeof config === "object" && config !== null && "ignore" in config)
      for (const name of Array.isArray(config.ignore) ? config.ignore : [])
        if (typeof name === "string") ignored.add(name);
  }
  const packages = new Map<string, EnginePackage>();
  for (const file of files) {
    const manifest = readManifest(root, file, base);
    if (manifest.private === true || typeof manifest.name !== "string")
      continue;
    if (packages.has(manifest.name))
      throw new Error(`Duplicate published package name: ${manifest.name}`);
    const directory = path.posix.dirname(file);
    const engines = manifest.engines;
    const node =
      typeof engines === "object" &&
      engines !== null &&
      "node" in engines &&
      typeof engines.node === "string"
        ? engines.node
        : undefined;
    const optionalDependencies = manifest.optionalDependencies;
    packages.set(manifest.name, {
      name: manifest.name,
      ...(node === undefined ? {} : { node }),
      changesetsManaged:
        !ignored.has(manifest.name) &&
        (directory === "." || picomatch(patterns)(directory)),
      optionalDependencies:
        typeof optionalDependencies === "object" &&
        optionalDependencies !== null &&
        !Array.isArray(optionalDependencies)
          ? Object.keys(optionalDependencies)
          : [],
    });
  }
  return packages;
};

const pendingMajorReleases = (root: string) => {
  const majors = new Set<string>();
  const files = git(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ".changeset/*.md",
  ])
    .split("\n")
    .filter(
      (file) =>
        file !== "" &&
        file !== ".changeset/README.md" &&
        existsSync(path.join(root, file)),
    );
  for (const file of files) {
    const source = readFileSync(path.join(root, file), "utf8");
    for (const { name, type } of parseChangeset(source).releases)
      if (type === "major") majors.add(name);
  }
  return majors;
};

const main = () => {
  const base = parseBase(process.argv.slice(2));
  if (base === undefined) {
    process.stdout.write("Usage: stll-engine-support --base <git ref>\n");
    return;
  }
  const root = process.cwd();
  const failures = checkEngineSupport({
    base: collectPackages(root, base),
    head: collectPackages(root),
    majorReleases: pendingMajorReleases(root),
  });
  for (const failure of failures)
    process.stderr.write(
      `[engine-support] ${failure.packageName} narrows Node support from ${failure.baseRange} to ${failure.headRange}; ${failure.releasingPackage} requires a pending major changeset\n`,
    );
  if (failures.length > 0) process.exitCode = 1;
};

try {
  main();
} catch (error) {
  process.stderr.write(
    `engine-support: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
