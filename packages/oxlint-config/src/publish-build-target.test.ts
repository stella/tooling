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

test("nullish transform target overrides preserve tsdown defaults", () => {
  for (const ignored of [undefined, null])
    expect(
      resolvedTsdownTarget([
        {
          target: ["node26"],
          inputOptions: { transform: { target: ignored } },
        },
      ]),
    ).toEqual({ type: "javascript", targets: ["node26"] });
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

test("asset classification follows actual publish overrides in both directions", () => {
  expect(
    assetOnlyTarget({
      exports: { ".": "./base.json" },
      publishConfig: { exports: { ".": "./dist/index.js" } },
    }),
  ).toBeUndefined();
  expect(
    assetOnlyTarget({
      exports: { ".": "./source/index.js" },
      publishConfig: { exports: { ".": "./base.json" } },
    }),
  ).toEqual({ type: "types-only" });
  expect(
    assetOnlyTarget({
      exports: { ".": { types: "./index.d.ts", default: "./base.json" } },
      publishConfig: {
        exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
      },
    }),
  ).toBeUndefined();
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
        4,
        "{ entry: ['entry.js'], dts: false, target: 'node26', inputOptions: { transform: { target: undefined } } }",
        ["node26"],
      ],
      [
        5,
        "{ entry: ['entry.js'], dts: false, target: 'node26', inputOptions: { transform: { target: null } } }",
        ["node26"],
      ],
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
    writeFileSync(
      path.join(directory, "tsdown.config.mjs"),
      "export default { entry: ['entry.js'], dts: false, target: 'node22' };\n",
    );
    for (const build of [
      "tsdown && tsdown --target node26",
      "tsdown --target node26 && tsdown",
      "tsdown && tsdown",
      'tsdown && ts"down" --target node26',
      "tsdown && tsd\\own --target node26",
      "tsdown && ./node_modules/.bin/tsdown --target node26",
      ["tsdown && tsd\\", "own --target node26"].join("\n"),
      ['tsdown && "tsd\\', 'own" --target node26'].join("\n"),
      'tsdown && t"sc" --target ESNext --outDir dist',
    ]) {
      writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({ ...manifest, scripts: { build } }),
      );
      await expect(resolvePublishBuildTarget(directory)).rejects.toThrow(
        "tsdown",
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
