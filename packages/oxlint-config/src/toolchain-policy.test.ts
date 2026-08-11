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
      typescriptInstallLayouts: [
        {
          compilerPackage: "typescript",
          compilerSpecifier: "7.0.2",
          type: "direct",
          typecheckCommand: "tsc --noEmit",
        },
        {
          compatibilityPackage: "typescript",
          compatibilitySpecifier: "6.0.3",
          compilerPackage: "@typescript/native",
          compilerSpecifier: "npm:typescript@7.0.2",
          type: "split-compatibility",
          typecheckCommand:
            "node ./node_modules/@typescript/native/bin/tsc --noEmit",
        },
      ],
      typescript6Compatibility: {
        apiConsumers: ["TypeScript compiler API"],
        packageAlias: "typescript-compat",
        peerBlockers: ["@astrojs/check", "@typescript-eslint/utils"],
        version: "6.0.3",
      },
    });
  });

  test("rejects pre-TS7 tsgolint consumers", async () => {
    const oxlintPackage = await readJson("packages/oxlint-config/package.json");

    expect(oxlintPackage).toEqual(
      expect.objectContaining({
        peerDependencies: {
          oxlint: ">=1.75.0 <2",
          "oxlint-tsgolint": ">=7.0.2001 <8",
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
