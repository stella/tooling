import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import packageJson from "../package.json";
import { syncWorkspaceVersions } from "./lib/bun-lock-workspace-versions";

const publishablePackageFiles = async (): Promise<string[]> => {
  const packageDirectory = new URL("../packages/", import.meta.url);
  const entries = await readdir(packageDirectory, { withFileTypes: true });
  const packageFiles: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifest: unknown = await Bun.file(
      new URL(`./${entry.name}/package.json`, packageDirectory),
    )
      .json()
      .catch(() => null);
    if (typeof manifest !== "object" || manifest === null) continue;
    if ("private" in manifest && manifest.private === true) continue;
    if (!("publishConfig" in manifest)) continue;

    packageFiles.push(`packages/${entry.name}/package.json`);
  }

  return packageFiles.sort();
};

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

    for (const packageFile of await publishablePackageFiles()) {
      const packageDirectory = packageFile.replace("/package.json", "");
      expect(pushTrigger).toContain(`${packageDirectory}/CHANGELOG.md`);
      expect(pushTrigger).not.toContain(packageFile);
    }
  });

  test("central publisher receives every publishable package", async () => {
    const publishWorkflow = await Bun.file(
      new URL("../.github/workflows/publish.yml", import.meta.url),
    ).text();
    const releaseJob = publishWorkflow.slice(
      publishWorkflow.indexOf("  release:"),
    );
    const packageBlock = releaseJob.match(
      /package-files: \|\n(?<packageFiles>(?: {8}packages\/[^\n]+\n)+)/u,
    );

    expect(packageBlock?.groups?.packageFiles).toBeDefined();
    const packageFiles = packageBlock?.groups?.packageFiles
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .sort();

    expect(packageFiles).toEqual(await publishablePackageFiles());
  });

  test("release caller can verify and download package artifacts", async () => {
    const publishWorkflow = await Bun.file(
      new URL("../.github/workflows/publish.yml", import.meta.url),
    ).text();
    const releaseJob = publishWorkflow.slice(
      publishWorkflow.indexOf("  release:"),
    );

    expect(releaseJob).toContain("actions: read");
    expect(releaseJob).toContain(
      "github.ref == 'refs/heads/main'\n      && (github.event_name == 'push' || inputs.publish_to_npm)",
    );
    expect(releaseJob.indexOf("actions: read")).toBeLessThan(
      releaseJob.indexOf("uses: stella/.github/"),
    );
  });

  test("manual recovery binds prior artifacts without replacing the build checkout", async () => {
    const publishWorkflow = await Bun.file(
      new URL("../.github/workflows/publish.yml", import.meta.url),
    ).text();

    expect(publishWorkflow).toContain("artifact_run_id:");
    expect(publishWorkflow).toContain("source_ref:");
    expect(publishWorkflow).not.toContain(
      "ref: ${{ inputs.source_ref || github.sha }}",
    );
    expect(publishWorkflow).toContain(
      "artifact-run-id: ${{ inputs.artifact_run_id || '' }}",
    );
    expect(publishWorkflow).toContain(
      "source-ref: ${{ inputs.source_ref || '' }}",
    );
  });
});
