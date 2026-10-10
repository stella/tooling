import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { consumerBuildApprovals } from "./consumer-build-approvals";
import { assertConsumerFixtureManifest } from "./consumer-compat-config";

test("only declared dependencies receive installed build approvals, including aliases", async () => {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "consumer-approvals-")),
  );
  try {
    for (const [key, name, version] of [
      ["addon", "real-addon", "1.2.0"],
      ["local", "real-local", "1.0.0"],
      ["typescript", "typescript", "6.0.3"],
    ] as const) {
      await mkdir(path.join(directory, "node_modules", key), {
        recursive: true,
      });
      await writeFile(
        path.join(directory, "node_modules", key, "package.json"),
        JSON.stringify({ name, version }),
      );
    }
    const manifest = {
      dependencies: { addon: "npm:real-addon@1.2.0", local: "file:./local" },
      devDependencies: { typescript: "6.0.3" },
      optionalDependencies: { skipped: "1.0.0" },
    };
    expect(
      await consumerBuildApprovals({
        directory,
        manifest,
        manager: "npm",
        lock: {
          packages: {
            "node_modules/addon": {
              version: "1.2.0",
              resolved: "https://registry.npmjs.org/addon/-/addon-1.2.0.tgz",
            },
            "node_modules/local": { resolved: "local", link: true },
            "node_modules/typescript": { version: "6.0.3" },
            "node_modules/transitive": { version: "9.0.0" },
            "node_modules/skipped": { version: "1.0.0", optional: true },
          },
        },
      }),
    ).toEqual({
      approvals: {
        "real-addon@1.2.0": true,
        "file:local": true,
        "typescript@6.0.3": true,
      },
      rebuildTargets: ["addon", "local", "typescript"].map((key) =>
        path.join(directory, "node_modules", key),
      ),
    });
    expect(
      await consumerBuildApprovals({
        directory,
        manifest,
        manager: "pnpm",
        lock: {
          importers: {
            ".": {
              dependencies: {
                addon: { version: "1.2.0(react@19.1.0)" },
                local: { version: "file:local" },
              },
              devDependencies: { typescript: { version: "6.0.3" } },
              optionalDependencies: { skipped: { version: "1.0.0" } },
            },
          },
          packages: { "transitive@9.0.0": {} },
        },
      }),
    ).toEqual({
      approvals: {
        "real-addon@1.2.0": true,
        "real-local@file:local": true,
        "typescript@6.0.3": true,
      },
      rebuildTargets: ["addon", "local", "typescript"].map((key) =>
        path.join(directory, "node_modules", key),
      ),
    });
    for (const manager of ["npm", "pnpm"] as const)
      await assert.rejects(
        consumerBuildApprovals({
          directory,
          manager,
          manifest: { dependencies: { skipped: "1.0.0" } },
          lock:
            manager === "npm"
              ? { packages: { "node_modules/skipped": { version: "1.0.0" } } }
              : {
                  importers: {
                    ".": { dependencies: { skipped: { version: "1.0.0" } } },
                  },
                },
        }),
        /ENOENT/,
      );
    expect(() =>
      assertConsumerFixtureManifest({ allowScripts: { "*": true } }),
    ).toThrow("allowScripts");
    await assert.rejects(
      consumerBuildApprovals({
        directory,
        manifest,
        manager: "pnpm",
        lock: { importers: {} },
      }),
      /missing resolved/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
