import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertDeclarationOnlyOutput,
  reviewedViteDtsOptions,
  snapshotDeclarationDirectory,
} from "./publish-build-target-vite-dts";
import {
  emitDeclarations,
  withoutSideEffectImports,
} from "./publish-build-target-vite-dts-helper";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const scratchDirectory = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "reviewed-vite-dts-"));
  directories.push(directory);
  return directory;
};
const write = (root: string, files: Record<string, string>) => {
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  }
};
const tsconfig = (compilerOptions: Record<string, unknown> = {}) =>
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      noUnusedLocals: true,
      skipLibCheck: true,
      types: [],
      ...compilerOptions,
    },
    include: ["src"],
  });

test("default and existing static declaration options are frozen and isolated from caller mutation", () => {
  expect(reviewedViteDtsOptions()).toEqual({});
  const include = ["src/**/*"];
  const compilerOptions = { declarationMap: false };
  const options = reviewedViteDtsOptions({
    include,
    exclude: "src/**/*.test.ts",
    entryRoot: "src",
    compilerOptions,
  });
  include.push("outside/**/*");
  compilerOptions.declarationMap = true;
  expect(options.include).toEqual(["src/**/*"]);
  expect(options.exclude).toEqual(["src/**/*.test.ts"]);
  expect(options.compilerOptions).toEqual({ declarationMap: false });
  expect(Object.isFrozen(options)).toBe(true);
  expect(Object.isFrozen(options.include)).toBe(true);
});

test("the option boundary rejects callbacks, foreign plugin options and output escapes", () => {
  for (const key of [
    "afterBuild",
    "beforeWriteFile",
    "resolvers",
    "processor",
    "root",
    "outDirs",
    "aliases",
    "pathsToAliases",
    "strictOutput",
    "declarationOnly",
  ])
    expect(() => reviewedViteDtsOptions({ [key]: () => undefined })).toThrow(
      "Unreviewed",
    );
  for (const options of [
    { compilerOptions: { declarationMap: true } },
    { compilerOptions: { declarationMap: false, plugins: [] } },
    { include: "../outside/*" },
    { include: [] },
    { entryRoot: "/outside" },
  ])
    expect(() => reviewedViteDtsOptions(options)).toThrow();
  expect(() =>
    reviewedViteDtsOptions(
      Object.defineProperty({}, "include", { get: () => ["src/*"] }),
    ),
  ).toThrow("accessors");
});

test("only declaration files and their maps can be added, changed or removed", () => {
  const output = scratchDirectory();
  write(output, { "index.js": "code", "index.d.ts": "declaration" });
  const before = snapshotDeclarationDirectory(output);
  write(output, {
    "index.d.ts": "changed",
    "index.d.mts": "",
    "index.d.cts.map": "",
    "nested/index.d.ts": "",
  });
  expect(() =>
    assertDeclarationOnlyOutput({
      before,
      after: snapshotDeclarationDirectory(output),
    }),
  ).not.toThrow();
  for (const file of ["index.js", "index.mjs", "index.cjs", "index.css"]) {
    const changed = { ...before, [file]: "other" };
    expect(() =>
      assertDeclarationOnlyOutput({ before, after: changed }),
    ).toThrow(file);
  }
  expect(() =>
    assertDeclarationOnlyOutput({ before, after: { "index.d.ts": "" } }),
  ).toThrow("index.js");
});

test("side-effect imports leave declarations; type and named imports stay", () => {
  expect(
    withoutSideEffectImports(
      "index.d.ts",
      'import "./styles.css";\nimport type {} from "./types";\nimport { type A } from "./a";\nimport "./runtime";\r\nexport declare const value: A;\n',
    ),
  ).toBe(
    'import type {} from "./types";\nimport { type A } from "./a";\nexport declare const value: A;\n',
  );
});

test("tsrs emits declarations with doc comments under entryRoot and leaves JavaScript output alone", async () => {
  const root = scratchDirectory();
  write(root, {
    "tsconfig.json": tsconfig({ declarationMap: true }),
    "src/index.ts":
      'import "./styles.css";\nimport type { Shape } from "./nested/shape";\nexport * from "./nested/shape";\nconst unused = 1;\n/** Documented area. */\nexport const area = (shape: Shape): number => shape.width * shape.height;\n',
    "src/nested/shape.ts":
      "export interface Shape { width: number; height: number }\n",
    "src/index.test.ts": "export const ignored = true;\n",
    "src/styles.css": "",
    "dist/index.js": "export const area = () => 0;\n",
  });
  const warnings: string[] = [];
  await emitDeclarations({
    root,
    output: path.join(root, "dist"),
    options: reviewedViteDtsOptions({
      include: ["src/**/*"],
      exclude: ["src/**/*.test.ts"],
      entryRoot: "src",
      compilerOptions: { declarationMap: false },
    }),
    warn: (message) => warnings.push(message),
  });
  expect(
    readdirSync(path.join(root, "dist"), { recursive: true }).toSorted((a, b) =>
      String(a).localeCompare(String(b)),
    ),
  ).toEqual(["index.d.ts", "index.js", "nested", "nested/shape.d.ts"]);
  expect(readFileSync(path.join(root, "dist/index.d.ts"), "utf8")).toBe(
    'import type { Shape } from "./nested/shape";\nexport * from "./nested/shape";\n/** Documented area. */\nexport declare const area: (shape: Shape) => number;\n',
  );
  expect(readFileSync(path.join(root, "dist/index.js"), "utf8")).toBe(
    "export const area = () => 0;\n",
  );
  expect(warnings).toEqual([]);
}, 60_000);

test("type errors warn and still emit; path aliases and inputs outside entryRoot fail", async () => {
  const root = scratchDirectory();
  write(root, {
    "tsconfig.json": tsconfig(),
    "src/index.ts": 'export const value: number = "text";\n',
    "other/extra.ts": "export const extra = 1;\n",
  });
  const output = path.join(root, "dist");
  const warnings: string[] = [];
  await emitDeclarations({
    root,
    output,
    options: reviewedViteDtsOptions(),
    warn: (message) => warnings.push(message),
  });
  expect(readFileSync(path.join(output, "index.d.ts"), "utf8")).toBe(
    "export declare const value: number;\n",
  );
  expect(warnings.join("\n")).toContain("TS2322");
  await assert.rejects(
    emitDeclarations({
      root,
      output,
      options: reviewedViteDtsOptions({
        include: ["src/**/*", "other/**/*"],
        entryRoot: "src",
      }),
      warn: () => undefined,
    }),
    /Declaration emit failed/,
  );
  write(root, {
    "tsconfig.json": tsconfig({ paths: { "#lib/*": ["./src/*"] } }),
  });
  await assert.rejects(
    emitDeclarations({
      root,
      output,
      options: reviewedViteDtsOptions(),
      warn: () => undefined,
    }),
    /compilerOptions\.paths/,
  );
}, 60_000);
