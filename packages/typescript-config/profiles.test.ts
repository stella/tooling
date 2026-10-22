/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import base from "./base.json";
import manifest from "./package.json";
import contract from "./publish-contract.json";
import singleChecker from "./single-checker.json";

const packageRoot = import.meta.dir;
const repositoryRoot = resolve(packageRoot, "../..");
const require = createRequire(import.meta.url);
const bunTypesManifest = require.resolve("bun-types/package.json");
const nodeTypesRoot = dirname(
  createRequire(bunTypesManifest).resolve("@types/node/package.json"),
);

test("every public profile is packaged and declared in the publish contract", async () => {
  expect(manifest.exports).toEqual(contract.entryPoints.exports);
  for (const [specifier, file] of Object.entries(manifest.exports)) {
    expect(specifier).toBe(file);
    const profile: unknown = JSON.parse(
      await readFile(join(packageRoot, file), "utf8"),
    );
    expect(profile).toHaveProperty(
      "$schema",
      "https://json.schemastore.org/tsconfig",
    );
    expect(profile).toHaveProperty("display", expect.any(String));
  }
}, 15_000);

test("base owns universal diagnostics while consumers own emit, identity and caching", () => {
  expect(base.compilerOptions.allowUnreachableCode).toBe(false);
  expect(base.compilerOptions.allowUnusedLabels).toBe(false);
  for (const option of [
    "checkers",
    "rewriteRelativeImportExtensions",
    "preserveSymlinks",
    "incremental",
    "tsBuildInfoFile",
  ]) {
    expect(base.compilerOptions).not.toHaveProperty(option);
  }
  expect(singleChecker.compilerOptions).toEqual({ checkers: 1 });
}, 15_000);

// Compiler processes run in CI; local targeted tests verify the package contract.
for (const specifier of Object.keys(manifest.exports)) {
  test.skipIf(process.env.CI !== "true")(
    `${specifier} resolves as a consumer export and compiles a fixture`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "stll-ts-profile-"));
      try {
        await mkdir(join(directory, "node_modules/@stll"), { recursive: true });
        await mkdir(join(directory, "node_modules/@types"));
        await symlink(
          packageRoot,
          join(directory, "node_modules/@stll/typescript-config"),
          "dir",
        );
        await symlink(
          join(repositoryRoot, "node_modules/bun-types"),
          join(directory, "node_modules/bun-types"),
          "dir",
        );
        await symlink(
          nodeTypesRoot,
          join(directory, "node_modules/@types/node"),
          "dir",
        );
        await writeFile(join(directory, "package.json"), '{"type":"module"}');
        await writeFile(
          join(directory, "input.ts"),
          "export const value: number = 1;\n",
        );
        if (
          ["./react-library.json", "./single-checker.json"].includes(specifier)
        ) {
          await writeFile(
            join(directory, "view.tsx"),
            "export const view = <div />; export const title: string = document.title;\n",
          );
          await writeFile(
            join(directory, "jsx-runtime.d.ts"),
            'declare module "react/jsx-runtime" { export namespace JSX { interface IntrinsicElements { div: object } } }\n',
          );
        }
        const config = join(directory, "tsconfig.json");
        await writeFile(
          config,
          JSON.stringify({
            extends:
              specifier === "./single-checker.json"
                ? [
                    "@stll/typescript-config/react-library.json",
                    "@stll/typescript-config/single-checker.json",
                  ]
                : `@stll/typescript-config/${specifier.slice(2)}`,
            include: ["*.ts", "*.tsx"],
          }),
        );
        const result = spawnSync(
          process.execPath,
          [
            join(repositoryRoot, "node_modules/typescript/bin/tsc"),
            "-p",
            config,
          ],
          { encoding: "utf8" },
        );
        expect(result.error).toBeUndefined();
        expect(result.stdout + result.stderr).toBe("");
        expect(result.status).toBe(0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
