import { readdir, readFile, stat } from "node:fs/promises";
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
const checkRealAncestors = async (root: string, directory: string) => {
  let parent = root;
  for (const component of directory
    .split("/")
    .filter((part) => part !== "." && part !== "")) {
    parent = join(parent, component);
    await checkGeneratedOutput(join(parent, ".stll-path-check"));
  }
};
const safeManifest = async (root: string, directory: string) => {
  await checkRealAncestors(root, directory);
  const path = join(root, directory, "Cargo.toml");
  const output = await checkGeneratedOutput(path);
  return output === undefined ? undefined : parse(await readFile(path, "utf8"));
};

/** Keep globstar states alive while consuming only actual directory components. */
const memberPrefixMatcher = (pattern: string) => {
  const segments = pattern.split("/");
  // Cross-separator groups cannot be matched one component at a time. Retain
  // conservative feasibility from that group onward, after matching its prefix.
  const uncertain = segments.findIndex((segment) => {
    const closing: string[] = [];
    for (const character of segment) {
      if (closing.at(-1) === "]") {
        if (character === "]") closing.pop();
        continue;
      }
      if (character === "[") closing.push("]");
      else if (character === "{") closing.push("}");
      else if (character === "(") closing.push(")");
      else if (character === closing.at(-1)) closing.pop();
    }
    return closing.length > 0;
  });
  const matchers = segments.map((segment) => picomatch(segment, { dot: true }));
  return (directory: string) => {
    if (pattern.startsWith("!") && !pattern.startsWith("!(")) return true;
    let states = new Set([0]);
    const expand = () => {
      for (const state of states)
        if (segments[state] === "**") states.add(state + 1);
    };
    expand();
    for (const component of directory === "." ? [] : directory.split("/")) {
      if (uncertain >= 0 && states.has(uncertain)) return true;
      const next = new Set<number>();
      for (const state of states) {
        if (segments[state] === "**") next.add(state);
        else if (matchers[state]?.(component)) next.add(state + 1);
      }
      states = next;
      expand();
    }
    return states.size > 0;
  };
};

/** Expand only declared member subtrees, then follow in-tree path dependencies. */
export const rustWorkspaceMembers = async (
  root: string,
  manifest: Record<string, unknown>,
) => {
  const workspace = manifest["workspace"];
  if (!record(workspace))
    throw new Error("workspace kind requires a workspace manifest");
  const declaredMembers = patterns(workspace["members"]);
  const excludes = patterns(workspace["exclude"]);
  const within = (directory: string, prefix: string) =>
    prefix === "." || directory === prefix || directory.startsWith(`${prefix}/`);
  // Cargo checks literal path prefixes here, including the original member
  // strings. A glob-expanded member does not override an exclusion prefix.
  const excluded = (directory: string) =>
    excludes.some((prefix) => within(directory, prefix)) &&
    !declaredMembers.some((prefix) => within(directory, prefix));
  const excludedSubtree = (directory: string) =>
    excluded(directory) &&
    !declaredMembers.some((member) => within(member, directory));
  const members = new Map<string, Record<string, unknown>>();
  if (record(manifest["package"])) members.set(".", manifest);
  for (const pattern of declaredMembers) {
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
    let prunedExclusion = false;
    const canContainMember = memberPrefixMatcher(pattern);
    const maximumDepth = pattern.includes("**")
      ? Infinity
      : pattern.split("/").length;
    const walk = async (directory: string) => {
      const depth = directory === "." ? 0 : directory.split("/").length;
      if (!canContainMember(directory)) return;
      if (excludedSubtree(directory)) {
        prunedExclusion = true;
        return;
      }
      if (picomatch.isMatch(directory, pattern, { dot: true })) {
        matches++;
        if (!excluded(directory)) {
          const member = await safeManifest(root, directory);
          if (member === undefined)
            throw new Error(`missing workspace member manifest: ${directory}`);
          members.set(directory, member);
        }
      }
      if (depth >= maximumDepth) return;
      // Validate ancestors before traversing a declared subtree.
      await checkRealAncestors(root, directory);
      for (const entry of await readdir(join(root, directory), {
        withFileTypes: true,
      })) {
        const child = posix.join(directory, entry.name);
        if (!canContainMember(child)) continue;
        if (excludedSubtree(child)) {
          prunedExclusion = true;
          continue;
        }
        if (entry.isSymbolicLink()) {
          // Follow metadata only: regular-file links cannot contain members.
          // Relevant dangling/cyclic links fail closed when stat throws.
          if ((await stat(join(root, child))).isDirectory())
            throw new Error("workspace members must use real directories");
          continue;
        }
        if (entry.isDirectory()) await walk(child);
      }
    };
    await walk(scan.base || ".");
    if (matches === 0 && !prunedExclusion)
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
