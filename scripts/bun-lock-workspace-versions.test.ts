import { describe, expect, test } from "bun:test";

import packageJson from "../package.json";
import { syncWorkspaceVersions } from "./lib/bun-lock-workspace-versions";

const fixture = `{
  "lockfileVersion": 1,
  "workspaces": {
    "packages/core": {
      "name": "@stll/core",
      "version": "1.0.0",
      "dependencies": { "version": "do-not-touch" },
    },
    "packages/escaped\\u002dname": { "version": "2.0.0" },
  },
  "packages": [{ "version": "also-do-not-touch" }],
}\n`;

describe("bun.lock workspace self-version synchronization", () => {
  test("changes only the exact workspace version string spans", () => {
    const result = syncWorkspaceVersions(
      fixture,
      new Map([
        ["packages/core", "1.1.0"],
        ["packages/escaped-name", "2.1.0"],
      ]),
    );

    expect(result.mismatches).toHaveLength(2);
    expect(result.text).toBe(
      fixture
        .replace('"version": "1.0.0"', '"version": "1.1.0"')
        .replace('"version": "2.0.0"', '"version": "2.1.0"'),
    );
    expect(result.text).toContain('"version": "do-not-touch"');
    expect(result.text).toContain('"version": "also-do-not-touch"');
  });

  test("version-up/version-down is byte-identical", () => {
    const up = syncWorkspaceVersions(
      fixture,
      new Map([["packages/core", "1.1.0"]]),
    ).text;
    const down = syncWorkspaceVersions(
      up,
      new Map([["packages/core", "1.0.0"]]),
    ).text;

    expect(down).toBe(fixture);
  });

  test("refuses to invent missing workspace structure", () => {
    const result = syncWorkspaceVersions(
      fixture,
      new Map([["packages/missing", "1.0.0"]]),
    );

    expect(result.text).toBe(fixture);
    expect(result.mismatches).toEqual([
      { workspace: "packages/missing", expected: "1.0.0", actual: null },
    ]);
  });

  test("release versioning cannot delete or regenerate bun.lock", () => {
    const command = packageJson.scripts["changeset:version"];

    expect(command).not.toMatch(/\brm\b/);
    expect(command).toContain("check-lockfile-workspace-versions.ts --write");
    expect(command).toEndWith("bun install --frozen-lockfile");
  });

  test("automatic publishing only uses Changesets release signals", async () => {
    const publishWorkflow = await Bun.file(
      new URL("../.github/workflows/publish.yml", import.meta.url),
    ).text();
    const pushTrigger = publishWorkflow.slice(
      0,
      publishWorkflow.indexOf("  workflow_dispatch:"),
    );

    for (const packageName of [
      "typescript-config",
      "oxlint-config",
      "oxlint-plugin",
    ]) {
      expect(pushTrigger).toContain(`packages/${packageName}/CHANGELOG.md`);
      expect(pushTrigger).not.toContain(`packages/${packageName}/package.json`);
    }
  });

  test("release caller can verify and download package artifacts", async () => {
    const publishWorkflow = await Bun.file(
      new URL("../.github/workflows/publish.yml", import.meta.url),
    ).text();
    const releaseJob = publishWorkflow.slice(
      publishWorkflow.indexOf("  release:"),
    );

    expect(releaseJob).toContain("actions: read");
    expect(releaseJob.indexOf("actions: read")).toBeLessThan(
      releaseJob.indexOf("uses: stella/.github/"),
    );
  });
});
