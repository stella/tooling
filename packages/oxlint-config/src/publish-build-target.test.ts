import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assetOnlyTarget,
  resolvedTsdownTarget,
  resolvePublishBuildTarget,
} from "./publish-build-target";

test("resolved targets preserve every emitted configuration and final override", () => {
  expect(
    resolvedTsdownTarget([
      { target: ["node20.19.0"] },
      { target: ["node26"], inputOptions: { transform: { target: "node22" } } },
      { target: ["node26"], dts: { emitDtsOnly: true } },
      { target: undefined },
    ]),
  ).toEqual({
    type: "javascript",
    targets: ["esnext", "node20.19.0", "node22"],
  });
  expect(
    resolvedTsdownTarget([{ target: ["node26"], dts: { emitDtsOnly: true } }]),
  ).toEqual({ type: "types-only" });
  for (const inputOptions of [() => ({}), [], "dynamic"])
    expect(() => resolvedTsdownTarget([{ inputOptions }])).toThrow(
      "inputOptions",
    );
});

test("declaration and JSON assets explicitly have no JavaScript target", () => {
  expect(
    assetOnlyTarget({ exports: { "./base.json": "./base.json" } }),
  ).toEqual({ type: "types-only" });
  expect(assetOnlyTarget({ types: "./dist/index.d.ts" })).toEqual({
    type: "types-only",
  });
  for (const manifest of [
    { exports: { ".": "./dist/index.js" } },
    { types: "./dist/index.d.ts", main: "./dist/index.js" },
    { exports: { ".": "./base.json" }, scripts: { build: "generate" } },
    {},
  ])
    expect(assetOnlyTarget(manifest)).toBeUndefined();
});

test("the installed build resolver supplies engine defaults and real config mutations", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "publish-target-"));
  const require = createRequire(import.meta.url);
  try {
    mkdirSync(path.join(directory, "node_modules"));
    symlinkSync(
      path.dirname(require.resolve("tsdown/package.json")),
      path.join(directory, "node_modules/tsdown"),
    );
    writeFileSync(
      path.join(directory, "entry.js"),
      "export const value = 1;\n",
    );
    const manifest = {
      name: "example-target",
      type: "module",
      scripts: { build: "tsdown" },
      engines: { node: ">=20.19.0" },
    };
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify(manifest),
    );
    for (const [index, config, expected] of [
      [0, "{ entry: ['entry.js'], dts: false }", ["node20.19.0"]],
      [1, "{ entry: ['entry.js'], dts: false, target: 'es2020' }", ["es2020"]],
      [2, "{ entry: ['entry.js'], dts: false, target: false }", ["esnext"]],
      [
        3,
        "{ entry: ['entry.js'], dts: false, inputOptions: { transform: { target: 'node22' } } }",
        ["node22"],
      ],
    ] as const) {
      const configFile = path.join(directory, `tsdown.config.${index}.mjs`);
      writeFileSync(configFile, `export default ${config};\n`);
      // Separate directories give native imports a unique cache identity.
      const member = path.join(directory, `case-${index}`);
      mkdirSync(member);
      writeFileSync(
        path.join(member, "package.json"),
        JSON.stringify(manifest),
      );
      writeFileSync(path.join(member, "entry.js"), "export const value = 1;\n");
      writeFileSync(
        path.join(member, "tsdown.config.mjs"),
        `export default ${config};\n`,
      );
      expect(await resolvePublishBuildTarget(member)).toEqual({
        type: "javascript",
        targets: [...expected],
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
