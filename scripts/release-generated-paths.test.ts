/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import {
  releaseGeneratedPaths,
  workspaceVersionOutputs,
} from "./lib/release-generated-paths";
import { syncWorkspaceToolchainPins } from "./lib/toolchain-workspace-versions";

test("generated release paths include every canonical synchronization output exactly once", () => {
  for (const packageDirectories of [
    [],
    ["oxlint-config"],
    ["oxlint-config", "oxlint-plugin", "typescript-config"],
  ]) {
    const generated = releaseGeneratedPaths(packageDirectories);
    expect(new Set(generated).size).toBe(generated.length);
    for (const output of Object.values(workspaceVersionOutputs))
      expect(generated.filter((path) => path === output)).toHaveLength(1);
    expect(generated).toHaveLength(
      Object.keys(workspaceVersionOutputs).length +
        packageDirectories.length * 2,
    );
    expect(generated).not.toContain("packages/oxlint-config/src/index.ts");
  }
});

test("an owned plugin release can update policy after consuming its changeset", () => {
  const sourcePolicy = JSON.stringify({
    schemaVersion: 1,
    "@stll/oxlint-plugin": "0.2.0",
    oxlint: "1.81.0",
  });
  const result = syncWorkspaceToolchainPins({
    policyText: sourcePolicy,
    workspaceVersions: new Map([["@stll/oxlint-plugin", "0.3.0"]]),
  });
  expect(result.text).not.toBe(sourcePolicy);
  expect(JSON.parse(result.text)["@stll/oxlint-plugin"]).toBe("0.3.0");
  const generated = new Set(
    releaseGeneratedPaths(["oxlint-config", "oxlint-plugin"]),
  );
  const changedFiles = [
    workspaceVersionOutputs.toolchain,
    workspaceVersionOutputs.lockfile,
    "packages/oxlint-plugin/package.json",
    "packages/oxlint-plugin/CHANGELOG.md",
  ];
  expect(changedFiles.every((path) => generated.has(path))).toBe(true);
  expect(generated.has(".changeset/source-update.md")).toBe(false);
});
