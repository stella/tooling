import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
  existsSync,
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
  assertTsdownBuildExtensions,
  resolvedTsdownTarget,
  resolvePublishBuildTarget,
  supportedPublishBuildCommand,
  publishBuildLifecycleScripts,
} from "./publish-build-target";
import {
  checkPublishContract,
  resolveManifestContract,
} from "./publish-contract";

test("tsdown rejects the entire unreviewed plugin and late output hook class", () => {
  for (const hook of [
    "options",
    "transform",
    "renderChunk",
    "generateBundle",
    "writeBundle",
    "buildEnd",
    "closeBundle",
  ])
    for (const location of ["plugins", "inputOptions", "outputOptions"]) {
      const plugins = [
        { name: "custom-output", [hook]: () => "custom output" },
      ];
      const extension =
        location === "plugins" ? { plugins } : { [location]: { plugins } };
      expect(() => assertTsdownBuildExtensions(extension)).toThrow(
        "supported target resolver",
      );
    }
  for (const key of ["banner", "footer", "intro", "outro"])
    for (const value of ["custom output", () => "custom output"])
      expect(() =>
        assertTsdownBuildExtensions({ outputOptions: { [key]: value } }),
      ).toThrow("supported target resolver");
  const hidden = { name: "hidden-output" };
  Object.defineProperty(hidden, "renderChunk", {
    value: () => "custom output",
  });
  expect(() => assertTsdownBuildExtensions({ plugins: [hidden] })).toThrow(
    "supported target resolver",
  );
  expect(() =>
    assertTsdownBuildExtensions({
      plugins: [
        {
          name: "config-target",
          tsdownConfig: () => undefined,
          tsdownConfigResolved: () => undefined,
        },
      ],
    }),
  ).not.toThrow();
  expect(() =>
    assertTsdownBuildExtensions({
      outputOptions: () => ({ banner: "custom output" }),
    }),
  ).toThrow("supported target resolver");
});

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

test("every emitted configuration requires valid target identifiers", () => {
  for (const target of [
    [],
    [""],
    [" "],
    ["es2022", ""],
    "es2022,",
    "es2022,node26",
    ",es2022",
    ",",
    Array(1),
  ]) {
    for (const configs of [[{ target }], [{ target: "es2022" }, { target }]])
      expect(() => resolvedTsdownTarget(configs)).toThrow();
  }
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
    assetOnlyTarget({ exports: { "./base.json": "./base.json" } }, "npm"),
  ).toEqual({ type: "types-only" });
  expect(assetOnlyTarget({ types: "./dist/index.d.ts" }, "npm")).toEqual({
    type: "types-only",
  });
  for (const manifest of [
    { exports: { ".": "./dist/index.js" } },
    { types: "./dist/index.d.ts", main: "./dist/index.js" },
    { exports: { ".": "./base.json" }, scripts: { build: "generate" } },
    {},
  ])
    expect(assetOnlyTarget(manifest, "npm")).toBeUndefined();
});

test("asset classification follows actual publish overrides in both directions", () => {
  expect(() =>
    assetOnlyTarget(
      {
        exports: { ".": "./base.json" },
        publishConfig: { exports: { ".": "./dist/index.js" } },
      },
      "npm",
    ),
  ).toThrow("npm pack does not apply differing publishConfig.exports");
  expect(() =>
    assetOnlyTarget(
      {
        exports: { ".": "./source/index.js" },
        publishConfig: { exports: { ".": "./base.json" } },
      },
      "npm",
    ),
  ).toThrow("npm pack does not apply differing publishConfig.exports");
  expect(
    assetOnlyTarget(
      {
        exports: { ".": "./base.json" },
        publishConfig: { exports: { ".": "./dist/index.js" } },
      },
      "pnpm",
    ),
  ).toBeUndefined();
  expect(
    assetOnlyTarget(
      {
        exports: { ".": "./source/index.js" },
        publishConfig: { exports: { ".": "./base.json" } },
      },
      "pnpm",
    ),
  ).toEqual({ type: "types-only" });
  expect(
    assetOnlyTarget(
      {
        exports: { ".": { types: "./index.d.ts", default: "./base.json" } },
        publishConfig: {
          exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
        },
      },
      "pnpm",
    ),
  ).toBeUndefined();
});

test("publish lifecycle hooks fail before asset returns or configuration imports", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "publish-lifecycle-"));
  const marker = path.join(directory, "config-imported");
  try {
    writeFileSync(
      path.join(directory, "tsdown.config.mjs"),
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'yes');export default {entry:['entry.js'],dts:false,target:'node20.19'};\n`,
    );
    for (const packer of ["npm", "pnpm"] as const)
      for (const lifecycle of publishBuildLifecycleScripts) {
        for (const value of ["", null, undefined])
          expect(() =>
            assetOnlyTarget(
              {
                exports: { ".": "./base.json" },
                scripts: { [lifecycle]: value },
              },
              packer,
            ),
          ).toThrow(`lifecycle script ${lifecycle}`);
        for (const manifest of [
          {
            name: "published-assets",
            exports: { ".": "./base.json" },
            scripts: { [lifecycle]: "emit-later" },
          },
          {
            name: "published-javascript",
            type: "module",
            main: "./dist/index.js",
            scripts: { build: "tsdown", [lifecycle]: "emit-later" },
          },
        ]) {
          expect(() => assetOnlyTarget(manifest, packer)).toThrow(
            `lifecycle script ${lifecycle}`,
          );
          writeFileSync(
            path.join(directory, "package.json"),
            JSON.stringify(manifest),
          );
          await assert.rejects(
            resolvePublishBuildTarget(directory, packer),
            new RegExp(`lifecycle script ${lifecycle}`, "u"),
          );
        }
      }
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
      expect(await resolvePublishBuildTarget(member, "npm")).toEqual({
        type: "javascript",
        targets: [...expected],
      });
    }
    for (const config of [
      "{ entry: ['entry.js'], dts: false, target: [] }",
      "[{ entry: ['entry.js'], dts: false, target: 'es2022' }, { entry: ['entry.js'], dts: false, target: [] }]",
      "{ entry: ['entry.js'], dts: false, inputOptions: { transform: { target: [''] } } }",
    ]) {
      writeFileSync(
        path.join(directory, "tsdown.config.mjs"),
        `export default ${config};\n`,
      );
      await assert.rejects(
        () => resolvePublishBuildTarget(directory, "npm"),
        /JavaScript target/,
      );
    }
    writeFileSync(
      path.join(directory, "tsdown.config.mjs"),
      "export default { entry: ['entry.js'], dts: false, target: 'es2022,node26' };\n",
    );
    const normalized = await resolvePublishBuildTarget(directory, "npm");
    expect(normalized).toEqual({
      type: "javascript",
      targets: ["es2022", "node26"],
    });
    expect(
      checkPublishContract({
        manifest,
        packer: "npm",
        target: normalized,
        contract: resolveManifestContract({
          manifest,
          target: normalized,
          packer: "npm",
        }),
        policy: { node: "22.12.0", typescript: "6.0.3" },
      }),
    ).toMatchObject([{ field: "target" }]);
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
      await assert.rejects(
        () => resolvePublishBuildTarget(directory, "npm"),
        /resolver/,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("the CLI loader parser transpiles TypeScript configs and their relative imports", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "publish-target-typescript-"),
  );
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
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "example-typescript-config",
        type: "module",
        scripts: { build: "tsdown" },
      }),
    );
    writeFileSync(
      path.join(directory, "target.ts"),
      "export const target: string = 'es2022';\n",
    );
    const configFile = path.join(directory, "tsdown.config.ts");
    const config = [
      "import { defineConfig } from 'tsdown';",
      "import { target } from './target.ts';",
      "const entry: string[] = ['entry.js'];",
      "export default defineConfig({ entry, target, dts: false });",
    ].join("\n");
    writeFileSync(configFile, config);
    expect(await resolvePublishBuildTarget(directory, "npm")).toEqual({
      type: "javascript",
      targets: ["es2022"],
    });
    for (const unsupported of [
      "{ entry: ['entry.js'], dts: false, inputOptions: () => ({ transform: { target: 'node26' } }) }",
      "{ entry: ['entry.js'], dts: false, hooks: { 'build:prepare': ({ options }) => { options.target = ['node26']; } } }",
      "{ entry: ['entry.js'], dts: false, plugins: [{ name: 'change-target', options: options => ({ ...options, transform: { target: 'node26' } }) }] }",
      "{ entry: ['entry.js'], dts: false, plugins: [{ name: 'change-output', renderChunk: () => 'custom output' }] }",
      "{ entry: ['entry.js'], dts: false, inputOptions: { plugins: [{ name: 'change-output', generateBundle() {} }] } }",
      "{ entry: ['entry.js'], dts: false, outputOptions: { plugins: [{ name: 'change-output', renderChunk: () => 'custom output' }] } }",
      "{ entry: ['entry.js'], dts: false, outputOptions: () => ({ banner: 'custom output' }) }",
    ]) {
      writeFileSync(configFile, `export default ${unsupported};\n`);
      await assert.rejects(
        () => resolvePublishBuildTarget(directory, "npm"),
        /supported target resolver/,
      );
    }
    writeFileSync(
      configFile,
      [
        "export default { entry: ['entry.js'], dts: false, target: 'es2020',",
        "plugins: [{ name: 'config-target', tsdownConfig(config) { config.target = 'es2022'; } }] };",
      ].join("\n"),
    );
    expect(await resolvePublishBuildTarget(directory, "npm")).toEqual({
      type: "javascript",
      targets: ["es2022"],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("build command grammar accepts only an entire supported invocation", () => {
  for (const [command, expected] of [
    ["tsdown", "tsdown"],
    ["vite build", "vite"],
    ["nuxt-module-build build", "nuxt-module-build"],
  ] as const) {
    expect(supportedPublishBuildCommand(command)).toBe(expected);
    expect(
      supportedPublishBuildCommand(`  ${command.replace(" ", "\t")}  `),
    ).toBe(expected);
    for (const composed of [
      `cd other && ${command}`,
      `${command} && copy-output`,
      `${command}; copy-output`,
      `NODE_ENV=production ${command}`,
      `(${command})`,
      `pnpm -C other exec ${command}`,
      `pnpm --dir other exec ${command}`,
      `bun --filter library ${command}`,
      `${command}\ncopy-output`,
      `${command}\n`,
    ])
      expect(() => supportedPublishBuildCommand(composed)).toThrow(
        "exact single invocation",
      );
  }
});
