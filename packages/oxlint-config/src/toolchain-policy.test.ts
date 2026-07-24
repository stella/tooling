/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");

const readJson = async (relativePath: string): Promise<unknown> =>
  Bun.file(path.join(repositoryRoot, relativePath)).json();

describe("shared toolchain policy", () => {
  test("pins the current TS7 and Oxc toolchain", async () => {
    const rootPackage = await readJson("package.json");
    const toolchain = await readJson(
      "packages/typescript-config/toolchain.json",
    );

    expect(rootPackage).toEqual(
      expect.objectContaining({
        devDependencies: expect.objectContaining({
          oxlint: "1.75.0",
          "oxlint-tsgolint": "7.0.2001",
          typescript: "7.0.2",
        }),
      }),
    );

    expect(toolchain).toEqual({
      oxlint: "1.75.0",
      "oxlint-tsgolint": "7.0.2001",
      typescript: "7.0.2",
      typescript6Compatibility: {
        peerBlockers: ["@astrojs/check", "@typescript-eslint/utils"],
        version: "6.0.3",
      },
    });
  });

  test("rejects pre-TS7 compiler and tsgolint consumers", async () => {
    const oxlintPackage = await readJson(
      "packages/oxlint-config/package.json",
    );
    const typescriptPackage = await readJson(
      "packages/typescript-config/package.json",
    );

    expect(oxlintPackage).toEqual(
      expect.objectContaining({
        peerDependencies: {
          oxlint: ">=1.75.0 <2",
          "oxlint-tsgolint": ">=7.0.2001 <8",
        },
      }),
    );

    expect(typescriptPackage).toEqual(
      expect.objectContaining({
        peerDependencies: {
          typescript: ">=7.0.2 <8",
        },
      }),
    );
  });
});
