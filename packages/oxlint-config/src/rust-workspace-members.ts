import { readdir, readFile } from "node:fs/promises";
import { posix, join } from "node:path";
import picomatch from "picomatch";
import { parse } from "smol-toml";

import { checkGeneratedOutput } from "./generated-file";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const patterns = (value: unknown) => {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error("workspace members/exclude must be arrays");
  return value.map((entry: unknown) => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.startsWith("/") ||
      entry.includes("\\") ||
      entry.split("/").includes("..")
    )
      throw new Error("workspace patterns must remain inside the repository");
    return posix.normalize(entry);
  });
};
const safeManifest = async (root: string, directory: string) => {
  let parent = root;
  for (const part of directory
    .split("/")
    .filter((part) => part !== "." && part !== "")) {
    parent = join(parent, part);
    await checkGeneratedOutput(join(parent, ".stll-path-check"));
  }
  const path = join(root, directory, "Cargo.toml");
  const stat = await checkGeneratedOutput(path);
  return stat === undefined ? undefined : parse(await readFile(path, "utf8"));
};

/** Expand only declared member subtrees, then follow in-tree path dependencies. */
export const rustWorkspaceMembers = async (
  root: string,
  manifest: Record<string, unknown>,
) => {
  const workspace = manifest["workspace"];
  if (!record(workspace))
    throw new Error("workspace kind requires a workspace manifest");
  const excludes = patterns(workspace["exclude"]);
  const excluded = (directory: string) =>
    excludes.some((pattern) => picomatch.isMatch(directory, pattern));
  const members = new Map<string, Record<string, unknown>>();
  if (record(manifest["package"])) members.set(".", manifest);
  for (const pattern of patterns(workspace["members"])) {
    const scan = picomatch.scan(pattern);
    if (!scan.isGlob) {
      if (excluded(pattern)) continue;
      const member = await safeManifest(root, pattern);
      if (member === undefined)
        throw new Error(`missing workspace member: ${pattern}`);
      members.set(pattern, member);
      continue;
    }
    let matches = 0;
    const maximumDepth = pattern.includes("**")
      ? Infinity
      : pattern.split("/").length;
    const walk = async (directory: string) => {
      const depth = directory === "." ? 0 : directory.split("/").length;
      if (excluded(directory)) return;
      if (picomatch.isMatch(directory, pattern)) {
        const member = await safeManifest(root, directory);
        if (member !== undefined) {
          members.set(directory, member);
          matches++;
        }
      }
      if (depth >= maximumDepth) return;
      // Validate ancestors before traversing a declared subtree.
      await safeManifest(root, directory);
      for (const entry of await readdir(join(root, directory), {
        withFileTypes: true,
      })) {
        if ([".git", "node_modules", "target"].includes(entry.name)) continue;
        const child = posix.join(directory, entry.name);
        if (entry.isSymbolicLink())
          throw new Error("workspace members must use real directories");
        if (entry.isDirectory()) await walk(child);
      }
    };
    await walk(scan.base || ".");
    if (matches === 0)
      throw new Error(`workspace pattern matched no manifests: ${pattern}`);
  }
  const inherited = workspace["dependencies"];
  // Map iteration includes newly added dependencies, so transitive members converge.
  for (const [directory, member] of members) {
    const owners = [member];
    const targets = member["target"];
    if (record(targets))
      for (const target of Object.values(targets))
        if (record(target)) owners.push(target);
    for (const owner of owners)
      for (const key of [
        "dependencies",
        "dev-dependencies",
        "build-dependencies",
      ]) {
        const dependencies = owner[key];
        if (!record(dependencies)) continue;
        for (const [name, dependency] of Object.entries(dependencies)) {
          if (!record(dependency)) continue;
          const isInherited = dependency["workspace"] === true;
          const resolved =
            isInherited && record(inherited) ? inherited[name] : dependency;
          if (!record(resolved) || typeof resolved["path"] !== "string")
            continue;
          if (
            posix.isAbsolute(resolved["path"]) ||
            resolved["path"].includes("\\")
          )
            throw new Error(
              "path dependencies must use portable relative paths",
            );
          const target = posix.normalize(
            posix.join(isInherited ? "." : directory, resolved["path"]),
          );
          if (
            target === ".." ||
            target.startsWith("../") ||
            excluded(target) ||
            members.has(target)
          )
            continue;
          const parsed = await safeManifest(root, target);
          if (parsed === undefined)
            throw new Error(`missing path dependency manifest: ${target}`);
          members.set(target, parsed);
        }
      }
  }
  return [...members.keys()]
    .sort()
    .map((directory) => posix.join(directory, "Cargo.toml"));
};
