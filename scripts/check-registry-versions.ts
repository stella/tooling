#!/usr/bin/env bun
// Release gate: every unpublished package version must sort above every
// version already on npm. The publish pipeline passes an explicit dist-tag,
// so npm never rejects a lower version and `latest` would move backwards.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  checkReleaseVersion,
  parseNpmVersions,
} from "./lib/registry-versions";

const ROOT = join(import.meta.dirname, "..");
const PACKAGES_DIRECTORY = join(ROOT, "packages");

type PublishableManifest = { name: string; version: string };

const readPublishableManifest = async (
  path: string,
): Promise<PublishableManifest | null> => {
  const manifest: unknown = await Bun.file(path)
    .json()
    .catch(() => null);
  if (typeof manifest !== "object" || manifest === null) return null;
  if ("private" in manifest && manifest.private === true) return null;
  if (!("name" in manifest) || typeof manifest.name !== "string") return null;
  if (!("version" in manifest) || typeof manifest.version !== "string") {
    return null;
  }
  return { name: manifest.name, version: manifest.version };
};

const publishedVersions = (name: string): string[] => {
  const result = Bun.spawnSync(["npm", "view", name, "versions", "--json"]);
  const stdout = result.stdout.toString();
  if (result.exitCode === 0) return parseNpmVersions(stdout);
  const output = `${stdout}\n${result.stderr.toString()}`;
  if (output.includes("E404")) return [];
  throw new Error(`npm view ${name} versions failed:\n${output.trim()}`);
};

const entries = await readdir(PACKAGES_DIRECTORY, { withFileTypes: true });
const failures: string[] = [];

for (const entry of entries.filter((item) => item.isDirectory())) {
  const manifest = await readPublishableManifest(
    join(PACKAGES_DIRECTORY, entry.name, "package.json"),
  );
  if (manifest === null) continue;

  const { name, version } = manifest;
  const check = checkReleaseVersion({
    version,
    publishedVersions: publishedVersions(name),
  });
  switch (check.status) {
    case "published":
      console.log(`${name}@${version}: already published.`);
      break;
    case "first-release":
      console.log(`${name}@${version}: first release.`);
      break;
    case "ascending":
      console.log(`${name}@${version}: above ${check.highest}.`);
      break;
    case "regression":
      failures.push(
        `${name}@${version} is not above published ${check.highest}.`,
      );
      break;
    default: {
      const exhaustive: never = check;
      throw new Error(`Unhandled check: ${JSON.stringify(exhaustive)}`);
    }
  }
}

if (failures.length > 0) {
  console.error(
    [
      "Release version regression detected:",
      ...failures.map((line) => `  - ${line}`),
      "Set package.json to the highest published version, then add a changeset.",
    ].join("\n"),
  );
  process.exit(1);
}
