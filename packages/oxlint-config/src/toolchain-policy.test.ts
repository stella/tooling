/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import path from "node:path";

import toolchainPolicy from "../toolchain.json";

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
  test("pins the current TS7 and Oxc toolchain", async () => {
    const rootPackage = await readJson("package.json");
    const toolchain = await readJson("packages/oxlint-config/toolchain.json");

    expect(rootPackage).toEqual(
      expect.objectContaining({
        devDependencies: expect.objectContaining({
          oxlint: "1.87.0",
          "oxlint-tsgolint": "7.0.2003",
          typescript: "7.0.2",
        }),
      }),
    );

    expect(toolchain).toEqual({
      bun: "1.4.3",
      oxlint: "1.87.0",
      "@oxlint/plugins": "1.87.0",
      oxfmt: "0.72.0",
      "oxlint-tsgolint": "7.0.2003",
      typescript: "7.0.2",
      typescriptInstallLayouts: [
        {
          compilerPackage: "typescript",
          compilerSpecifier: "7.0.2",
          type: "direct",
          typecheckCommand: "bun check",
        },
        {
          compatibilityPackage: "typescript",
          compatibilitySpecifier: "6.0.3",
          compilerPackage: "@typescript/native",
          compilerSpecifier: "npm:typescript@7.0.2",
          type: "split-compatibility",
          typecheckCommand: "bun check",
        },
      ],
      typescript6Compatibility: {
        apiConsumers: ["TypeScript compiler API"],
        packageAlias: "typescript-compat",
        peerBlockers: [
          "@astrojs/check",
          "@typescript-eslint/utils",
          "dependency-cruiser",
        ],
        version: "6.0.3",
      },
    });
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
