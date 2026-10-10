import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { valid } from "semver";

import { consumerRecord } from "./consumer-compat-config";

// Direct fixture declarations select installed identities; aliases never grant
// approval to the dependency key or to undeclared transitive packages.
export const consumerBuildApprovals = async ({
  manifest,
  lock,
  manager,
  directory,
}: {
  manifest: Record<string, unknown>;
  lock: unknown;
  manager: "npm" | "pnpm";
  directory: string;
}) => {
  if (!consumerRecord(lock))
    throw new Error("invalid consumer dependency lock");
  const approvals: Record<string, true> = {};
  const rebuildTargets = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    const entries = manifest[field];
    if (entries === undefined) continue;
    if (!consumerRecord(entries)) throw new Error(`invalid fixture ${field}`);
    for (const key of Object.keys(entries)) {
      const packages = lock["packages"];
      const importers = lock["importers"];
      const importer = consumerRecord(importers) ? importers["."] : undefined;
      const dependencies = consumerRecord(importer)
        ? importer[field]
        : undefined;
      const dependencyTable = manager === "npm" ? packages : dependencies;
      const installedKey = manager === "npm" ? `node_modules/${key}` : key;
      const dependency = consumerRecord(dependencyTable)
        ? dependencyTable[installedKey]
        : undefined;
      if (!consumerRecord(dependency)) {
        if (field === "optionalDependencies") continue;
        throw new Error(`missing resolved fixture dependency identity: ${key}`);
      }
      const installedDirectory = path.join(directory, "node_modules", key);
      if (field === "optionalDependencies") {
        try {
          await lstat(installedDirectory);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            continue;
          throw error;
        }
      }
      const installed: unknown = JSON.parse(
        await readFile(path.join(installedDirectory, "package.json"), "utf8"),
      );
      if (
        !consumerRecord(installed) ||
        typeof installed["name"] !== "string" ||
        installed["name"] === "" ||
        typeof installed["version"] !== "string" ||
        valid(installed["version"]) === null
      )
        throw new Error(
          `invalid installed fixture dependency identity: ${key}`,
        );
      const identity = `${installed["name"]}@${installed["version"]}`;
      // npm name selectors use the alias key; exact directories select only this installed node.
      rebuildTargets.add(await realpath(installedDirectory));
      const resolved = dependency["resolved"];
      if (
        manager === "npm" &&
        typeof resolved === "string" &&
        !resolved.startsWith("https://registry.npmjs.org/")
      )
        approvals[
          resolved.startsWith("file:") ? resolved : `file:${resolved}`
        ] = true;
      else {
        const version = dependency["version"];
        // pnpm matches local artifact builds by resolved source, using the installed real name.
        const source =
          manager === "pnpm" &&
          typeof version === "string" &&
          version.startsWith("file:")
            ? version.replace(/\([^)]*\)/g, "")
            : undefined;
        approvals[
          source === undefined ? identity : `${installed["name"]}@${source}`
        ] = true;
      }
    }
  }
  return { approvals, rebuildTargets: [...rebuildTargets] };
};
