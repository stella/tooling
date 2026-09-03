#!/usr/bin/env bun

import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PACKAGES_DIRECTORY = join(ROOT, "packages");
const OUTPUT_DELIMITER = "stella_release_packages";
const PACKAGE_DIRECTORY_PATTERN = /^[a-z0-9-]+$/;

const entries = await readdir(PACKAGES_DIRECTORY, { withFileTypes: true });
const packageDirectories: string[] = [];

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  if (!PACKAGE_DIRECTORY_PATTERN.test(entry.name)) {
    throw new Error(`Invalid package directory: ${entry.name}`);
  }

  const manifestPath = join(PACKAGES_DIRECTORY, entry.name, "package.json");
  const manifest: unknown = await Bun.file(manifestPath)
    .json()
    .catch(() => null);

  if (typeof manifest !== "object" || manifest === null) continue;
  if ("private" in manifest && manifest.private === true) continue;
  if (!("name" in manifest) || typeof manifest.name !== "string") {
    throw new Error(`Publishable package has no name: packages/${entry.name}`);
  }
  if (!("version" in manifest) || typeof manifest.version !== "string") {
    throw new Error(`Publishable package has no version: ${manifest.name}`);
  }
  if (
    !("publishConfig" in manifest) ||
    typeof manifest.publishConfig !== "object" ||
    manifest.publishConfig === null ||
    !("access" in manifest.publishConfig) ||
    manifest.publishConfig.access !== "public"
  ) {
    throw new Error(
      `Publishable package must set publishConfig.access to public: ${manifest.name}`,
    );
  }

  packageDirectories.push(entry.name);
}

packageDirectories.sort();

if (packageDirectories.length === 0) {
  throw new Error("No publishable packages found");
}

const packageFiles = packageDirectories.map(
  (directory) => `packages/${directory}/package.json`,
);
const releasePaths = packageDirectories.map(
  (directory) => `packages/${directory}/**`,
);
const generatedPaths = [
  "bun.lock",
  ...packageDirectories.flatMap((directory) => [
    `packages/${directory}/CHANGELOG.md`,
    `packages/${directory}/package.json`,
  ]),
];

const multilineOutput = (name: string, values: string[]): string =>
  [
    `${name}<<${OUTPUT_DELIMITER}`,
    ...values,
    OUTPUT_DELIMITER,
  ].join("\n");

console.log(`package-directories=${JSON.stringify(packageDirectories)}`);
console.log(multilineOutput("package-files", packageFiles));
console.log(multilineOutput("release-paths", releasePaths));
console.log(multilineOutput("generated-paths", generatedPaths));
