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
    expect(toolchain).toEqual(expect.objectContaining({ bun: "1.4.4" }));
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
    if (typeof oxlintPackage !== "object" || oxlintPackage === null)
      throw new Error(
        "packages/oxlint-config/package.json must be a JSON object",
      );
    const devDependencies: unknown = Reflect.get(
      oxlintPackage,
      "devDependencies",
    );
    if (typeof devDependencies !== "object" || devDependencies === null)
      throw new Error(
        "packages/oxlint-config/package.json must declare devDependencies",
      );
    const builtVite: unknown = Reflect.get(devDependencies, "vite");
    // The vite peer is pinned to the exact version the build helper is
    // built and tested against, so it follows the devDependency pin.
    expect(builtVite).toEqual(expect.stringMatching(/^\d+\.\d+\.\d+$/));

    expect(oxlintPackage).toEqual(
      expect.objectContaining({
        peerDependencies: {
          oxlint: ">=1.87.0 <2",
          "oxlint-tsgolint": ">=7.0.2003 <8",
          vite: builtVite,
        },
        peerDependenciesMeta: {
          vite: { optional: true },
        },
      }),
    );
  });

  test("no repository manifest installs or peers on TypeScript", async () => {
    for (const manifest of [
      "package.json",
      "packages/typescript-config/package.json",
      "packages/oxlint-config/package.json",
      "packages/oxlint-plugin/package.json",
      "packages/time/package.json",
      "packages/test-kit/package.json",
    ]) {
      const json = await readJson(manifest);
      if (typeof json !== "object" || json === null)
        throw new Error(`${manifest} must be an object`);
      for (const section of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        const entries: unknown = Reflect.get(json, section);
        if (typeof entries !== "object" || entries === null) continue;
        for (const name of ["typescript", "@typescript/native"])
          expect({
            manifest,
            section,
            name,
            declared: name in entries,
          }).toEqual({ manifest, section, name, declared: false });
      }
    }
  });
});
