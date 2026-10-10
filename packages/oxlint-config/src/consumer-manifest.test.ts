import { describe, expect, test } from "bun:test";

import {
  assertConsumerPublishableManifest,
  discoverConsumerManifests,
  discoverConsumerPackages,
} from "./consumer-compat-config";

const publicManifest = (name: unknown) => ({ name, version: "1.0.0" });

describe("consumer published manifest boundaries", () => {
  test("canonical scoped and unscoped npm names are accepted at the length boundary", () => {
    for (const name of [
      "library",
      "library-name_2.0",
      "@example/library",
      "@example/.library",
      "@example/_library",
      "a".repeat(214),
      `@scope/${"a".repeat(207)}`,
    ])
      expect(() =>
        assertConsumerPublishableManifest({
          directory: "packages/library",
          manifest: publicManifest(name),
        }),
      ).not.toThrow();
    expect(() =>
      assertConsumerPublishableManifest({
        directory: ".",
        manifest: { private: true },
      }),
    ).not.toThrow();
  });

  test("invalid public package names fail at the shared publication boundary", () => {
    for (const name of [
      undefined,
      null,
      1,
      "",
      "Library",
      "library name",
      "library/name",
      "library%20name",
      "library~name",
      ".library",
      "_library",
      "-library",
      "@scope",
      "@/library",
      "@scope/",
      "@scope/Library",
      "@scope/library/extra",
      "@scope/.",
      "@../library",
      "node_modules",
      "@scope/favicon.ico",
      "a".repeat(215),
      `@scope/${"a".repeat(208)}`,
    ])
      expect(() =>
        assertConsumerPublishableManifest({
          directory: "packages/library",
          manifest: publicManifest(name),
        }),
      ).toThrow("valid npm name: packages/library");
  });

  test("manifestless root and declared nested pnpm owners fail through both discovery APIs", () => {
    const manifests = {
      "packages/library/package.json": JSON.stringify(
        publicManifest("library"),
      ),
    };
    const assertRejectedOwner = (files: Record<string, string>) => {
      for (const discover of [
        discoverConsumerManifests,
        discoverConsumerPackages,
      ])
        expect(() => discover(files)).toThrow("adjacent tracked package.json");
    };
    assertRejectedOwner({
      ...manifests,
      "pnpm-workspace.yaml": "packages: [packages/*]\n",
    });
    assertRejectedOwner({
      "package.json": JSON.stringify({
        private: true,
        workspaces: ["owners/*"],
      }),
      "owners/nested/pnpm-workspace.yaml": "packages: [packages/*]\n",
      "owners/nested/packages/library/package.json":
        manifests["packages/library/package.json"],
    });
    assertRejectedOwner({
      "package.json": JSON.stringify({
        private: true,
        workspaces: ["owners/**/library"],
      }),
      "owners/nested/pnpm-workspace.yaml": "packages: [packages/*]\n",
      "owners/nested/packages/library/package.json":
        manifests["packages/library/package.json"],
    });
  });

  test("tracked unnamed owners remain supported and unrelated fixture workspaces stay excluded", () => {
    const files = {
      "package.json": JSON.stringify({
        private: true,
        workspaces: ["owners/*"],
      }),
      "owners/nested/package.json": JSON.stringify({ private: true }),
      "owners/nested/pnpm-workspace.yaml":
        "packages: [packages/*]\ncatalog: {react: 18.3.1}\n",
      "owners/nested/packages/library/package.json": JSON.stringify(
        publicManifest("library"),
      ),
      "fixtures/standalone/pnpm-workspace.yaml": "[invalid",
    };
    expect([...discoverConsumerManifests(files).keys()].sort()).toEqual([
      ".",
      "owners/nested",
      "owners/nested/packages/library",
    ]);
    expect([...discoverConsumerPackages(files).keys()]).toEqual(["library"]);
  });
});
