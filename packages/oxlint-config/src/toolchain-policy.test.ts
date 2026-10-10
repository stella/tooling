/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import path from "node:path";

import toolchainPolicy from "../toolchain.json";
import { checkToolchain } from "./toolchain-guard";
import { nodeSelectorMatches } from "./toolchain-node";
import { parseToolchainPolicy } from "./toolchain-schema";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");

const readJson = async (relativePath: string): Promise<unknown> =>
  Bun.file(path.join(repositoryRoot, relativePath)).json();

describe("shared toolchain policy", () => {
  test("keeps every Bun pin equal to the shared policy", async () => {
    const rootPackage = await readJson("package.json");
    const toolchain = await readJson("packages/oxlint-config/toolchain.json");
    expect(toolchain).toEqual(expect.objectContaining({ bun: "1.4.3" }));
    expect(rootPackage).toEqual(
      expect.objectContaining({
        packageManager: `bun@${toolchainPolicy.bun}`,
        devDependencies: expect.objectContaining({
          "bun-types": toolchainPolicy.bun,
        }),
      }),
    );
  });
  test("release runtime pins an exact patch inside the shared Node series", async () => {
    const selector = (
      await Bun.file(path.join(repositoryRoot, ".node-version")).text()
    ).trim();
    expect(selector).toMatch(/^\d+\.\d+\.\d+$/);
    expect(nodeSelectorMatches(selector, toolchainPolicy.node)).toBe(true);
  });

  test("repository conforms to every shared toolchain rule", () => {
    expect(
      checkToolchain({
        root: repositoryRoot,
        policy: parseToolchainPolicy(toolchainPolicy),
      }),
    ).toEqual([]);
  });

  test("rejects pre-TS7 tsgolint consumers", async () => {
    const oxlintPackage = await readJson("packages/oxlint-config/package.json");

    expect(oxlintPackage).toEqual(
      expect.objectContaining({
        peerDependencies: {
          oxlint: ">=1.87.0 <2",
          "oxlint-tsgolint": ">=7.0.2003 <8",
        },
      }),
    );
  });

  test("supports both TypeScript install layouts", async () => {
    const typescriptPackage = await readJson(
      "packages/typescript-config/package.json",
    );

    expect(typescriptPackage).toEqual(
      expect.objectContaining({
        peerDependencies: {
          typescript: ">=6.0.3 <8",
        },
      }),
    );
  });
});
