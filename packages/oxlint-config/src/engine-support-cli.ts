#!/usr/bin/env node
import parseChangeset from "@changesets/parse";
import { getPackagesSync, type Package } from "@manypkg/get-packages";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkEngineSupport, type EnginePackage } from "./engine-support";

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

const resolvedPackages = (root: string, base?: string) => {
  if (base === undefined) return getPackagesSync(root);

  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "engine-support-base-"),
  );
  try {
    for (const file of [...manifestFiles(root, base), "bun.lock"]) {
      const source = git(root, ["show", `${base}:${file}`]);
      const destination = path.join(temporaryRoot, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, source);
    }
    return getPackagesSync(temporaryRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
};

const allPackages = ({
  packages,
  rootPackage,
}: ReturnType<typeof getPackagesSync>) =>
  rootPackage === undefined ? packages : [rootPackage, ...packages];

const packageNodeRange = ({ packageJson }: Package) => {
  const engines = "engines" in packageJson ? packageJson.engines : undefined;
  return typeof engines === "object" &&
    engines !== null &&
    "node" in engines &&
    typeof engines.node === "string"
    ? engines.node
    : undefined;
};

const collectPackages = (root: string, base?: string) => {
  const discovered = allPackages(resolvedPackages(root, base));
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
  for (const pkg of discovered) {
    const { name, private: isPrivate } = pkg.packageJson;
    if (isPrivate === true || typeof name !== "string") continue;
    if (packages.has(name))
      throw new Error(`Duplicate published package name: ${name}`);
    const node = packageNodeRange(pkg);
    packages.set(name, {
      name,
      ...(node === undefined ? {} : { node }),
      changesetsManaged: !ignored.has(name),
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
      `[engine-support] ${failure.packageName} narrows Node support from ${failure.baseRange} to ${failure.headRange}; ${failure.packageName} requires a pending major changeset\n`,
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
