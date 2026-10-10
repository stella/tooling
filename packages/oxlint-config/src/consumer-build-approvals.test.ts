import { expect, test } from "bun:test";

import { consumerBuildApprovals } from "./consumer-build-approvals";
import { assertConsumerFixtureManifest } from "./consumer-compat-config";

test("only declared dependencies receive resolved build approvals", () => {
  const manifest = {
    dependencies: { addon: "^1.0.0", local: "file:./local" },
    devDependencies: { typescript: "6.0.3" },
  };
  expect(
    consumerBuildApprovals({
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
        },
      },
    }),
  ).toEqual({
    "addon@1.2.0": true,
    "file:local": true,
    "typescript@6.0.3": true,
  });
  expect(
    consumerBuildApprovals({
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
          },
        },
        packages: { "transitive@9.0.0": {} },
      },
    }),
  ).toEqual({
    "addon@1.2.0": true,
    "local@file:local": true,
    "typescript@6.0.3": true,
  });
  expect(() =>
    assertConsumerFixtureManifest({ allowScripts: { "*": true } }),
  ).toThrow("allowScripts");
  expect(() =>
    consumerBuildApprovals({
      manifest,
      manager: "pnpm",
      lock: { importers: {} },
    }),
  ).toThrow("missing resolved");
});
