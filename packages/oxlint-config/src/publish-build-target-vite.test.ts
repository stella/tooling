import { expect, test } from "bun:test";

import {
  assertReviewedVitePlugins,
  assertReviewedVueOptions,
  resolvedViteTarget,
  reviewedViteBuild,
} from "./publish-build-target-vite";

test("Vite native callbacks are version-profile-bound at their exact option paths", () => {
  const callback = () => undefined;
  for (const [name, field] of [
    ["builtin:vite-resolve", "resolveSubpathImports"],
    ["builtin:vite-dynamic-import-vars", "resolver"],
    ["builtin:vite-reporter", "logInfo"],
  ] as const) {
    const reviewed = [{ name, _options: { [field]: callback } }];
    expect(() =>
      assertReviewedVitePlugins({ reviewed, resolved: reviewed }),
    ).not.toThrow();
    expect(() =>
      assertReviewedVitePlugins({
        reviewed,
        resolved: [{ name, _options: { [field]: () => "custom output" } }],
      }),
    ).toThrow("Unreviewed Vite hook");
    expect(() =>
      assertReviewedVitePlugins({
        reviewed,
        resolved: [
          {
            name,
            _options: { [field]: callback, nested: { transform: callback } },
          },
        ],
      }),
    ).toThrow("Unsupported Vite hook metadata");
  }
  expect(() =>
    assertReviewedVitePlugins({
      reviewed: [
        { name: "builtin:vite-json", _options: { resolver: callback } },
      ],
      resolved: [],
    }),
  ).toThrow("Unsupported Vite hook metadata");
});

test("Vite canonical library profile copies only static build settings", () => {
  const profile = reviewedViteBuild({
    target: "node20.19",
    lib: { entry: "entry.ts", formats: ["es"], name: "Library" },
    plugins: [() => "custom plugin"],
    rolldownOptions: { plugins: [() => "custom output"] },
  });
  expect(profile["target"]).toBe("node20.19");
  expect(profile["lib"]).toEqual({
    entry: "entry.ts",
    formats: ["es"],
    name: "Library",
  });
  expect(Object.hasOwn(profile, "plugins")).toBe(false);
  expect(Object.hasOwn(profile, "rolldownOptions")).toBe(false);
  for (const build of [
    { target: () => "node26" },
    { lib: { entry: () => "entry.ts" } },
    { modulePreload: { resolveDependencies: () => [] } },
  ])
    expect(() => reviewedViteBuild(build)).toThrow(
      "Unsupported Vite hook metadata",
    );
  expect(reviewedViteBuild({})["lib"]).toBeUndefined();
});

test("Vue default options allow lifecycle values but reject custom compiler closures", () => {
  const options = {
    isProduction: false,
    compiler: null,
    customElement: /\.ce\.vue$/,
    root: "/fixture",
    sourceMap: true,
    cssDevSourcemap: false,
  };
  const reviewed = {
    name: "vite:vue",
    api: { options, include: /\.vue$/, exclude: undefined },
  };
  const plugin = {
    name: "vite:vue",
    api: {
      ...reviewed.api,
      options: {
        ...options,
        isProduction: true,
        sourceMap: false,
        devToolsEnabled: false,
      },
    },
  };
  expect(() => assertReviewedVueOptions({ plugin, reviewed })).not.toThrow();
  for (const extra of [
    { compiler: { compileTemplate: () => "output" } },
    { template: { compilerOptions: { nodeTransforms: [() => undefined] } } },
    { script: { babelParserPlugins: [() => undefined] } },
    { features: { optionsAPI: false } },
  ])
    expect(() =>
      assertReviewedVueOptions({
        plugin: {
          ...plugin,
          api: { ...plugin.api, options: { ...plugin.api.options, ...extra } },
        },
        reviewed,
      }),
    ).toThrow("Custom Vue plugin options");
  for (const include of [/\.custom$/, undefined])
    expect(() =>
      assertReviewedVueOptions({
        plugin: { ...plugin, api: { ...plugin.api, include } },
        reviewed,
      }),
    ).toThrow("Custom Vue plugin options");
});

test("Vite hook identities bind reviewed plugin names and the entire executable hook class", () => {
  const transform = () => undefined;
  const reviewed = [{ name: "vite:define", transform: { handler: transform } }];
  expect(() =>
    assertReviewedVitePlugins({ resolved: reviewed, reviewed }),
  ).not.toThrow();
  for (const hook of [
    "renderChunk",
    "generateBundle",
    "writeBundle",
    "transform",
    "options",
    "buildApp",
  ]) {
    expect(() =>
      assertReviewedVitePlugins({
        resolved: [{ name: "custom-output", [hook]: transform }],
        reviewed,
      }),
    ).toThrow("Unreviewed Vite plugin");
    expect(() =>
      assertReviewedVitePlugins({
        resolved: [{ name: "vite:define", [hook]: () => "custom output" }],
        reviewed,
      }),
    ).toThrow("Unreviewed Vite hook");
  }
  expect(() =>
    assertReviewedVitePlugins({
      resolved: [{ name: "other-plugin", transform: { handler: transform } }],
      reviewed,
    }),
  ).toThrow("Unreviewed Vite plugin");
});

test("Vite hook identity includes options and nonenumerable or inherited hooks", () => {
  const handler = () => undefined;
  const reviewed = [
    {
      name: "vite:define",
      transform: { handler, order: "pre", filter: { id: /\.vue$/ } },
    },
  ];
  expect(() =>
    assertReviewedVitePlugins({ reviewed, resolved: reviewed }),
  ).not.toThrow();
  for (const metadata of [
    { order: "post", filter: { id: /\.vue$/ } },
    { order: "pre", sequential: true, filter: { id: /\.vue$/ } },
    { order: "pre", filter: { id: /\.js$/ } },
  ])
    expect(() =>
      assertReviewedVitePlugins({
        reviewed,
        resolved: [
          { name: "vite:define", transform: { handler, ...metadata } },
        ],
      }),
    ).toThrow("Unreviewed Vite hook");
  const hidden = { name: "vite:define" };
  Object.defineProperty(hidden, "renderChunk", { value: handler });
  class InheritedPlugin {
    name = "vite:define";
    renderChunk() {
      return undefined;
    }
  }
  const symbolic = { name: "vite:define", [Symbol("renderChunk")]: handler };
  for (const plugin of [hidden, new InheritedPlugin(), symbolic])
    expect(() =>
      assertReviewedVitePlugins({ reviewed, resolved: [plugin] }),
    ).toThrow();
  expect(() =>
    assertReviewedVitePlugins({
      reviewed,
      resolved: [
        {
          name: "vite:define",
          transform: { handler, filter: { id: () => true } },
        },
      ],
    }),
  ).toThrow("Unsupported Vite hook metadata");
});

test("Vite plugin execution order and native compiler options match the reviewed profile", () => {
  const handler = () => undefined;
  const reviewed = [
    {
      name: "builtin:vite-json",
      enforce: "pre",
      apply: "build",
      _options: { namedExports: true, stringify: "auto", minify: true },
      transform: handler,
    },
  ];
  expect(() =>
    assertReviewedVitePlugins({ reviewed, resolved: reviewed }),
  ).not.toThrow();
  for (const override of [
    { enforce: "post" },
    { enforce: undefined },
    { apply: "serve" },
    { _options: { namedExports: true, stringify: "auto", minify: false } },
    { _options: undefined },
  ])
    expect(() =>
      assertReviewedVitePlugins({
        reviewed,
        resolved: reviewed.map((plugin) => Object.assign({}, plugin, override)),
      }),
    ).toThrow("Unreviewed Vite hook");
});

test("Vite final transform overrides take precedence, including explicit undefined", () => {
  for (const [target, expected] of [
    ["es2022", ["es2022"]],
    [undefined, ["esnext"]],
    [
      ["node22", "es2022", "node22"],
      ["es2022", "node22"],
    ],
  ] as const)
    expect(
      resolvedViteTarget({
        build: { target: "es2020", rolldownOptions: { transform: { target } } },
      }),
    ).toEqual({ type: "javascript", targets: expected });
  expect(resolvedViteTarget({ build: { target: false } })).toEqual({
    type: "javascript",
    targets: ["esnext"],
  });
  expect(
    resolvedViteTarget({ build: { target: ["chrome111", "safari16.4"] } }),
  ).toEqual({ type: "javascript", targets: ["chrome111", "safari16.4"] });
});

test("Vite unsupported resolved shapes fail before target classification", () => {
  for (const config of [
    {},
    { build: { target: [] } },
    { build: { target: null } },
    { builder: {}, build: {} },
    { build: { rolldownOptions: [] } },
    { build: { rolldownOptions: { transform: () => ({}) } } },
    { build: { rolldownOptions: { transform: { target: false } } } },
  ])
    expect(() => resolvedViteTarget(config)).toThrow();
});

test("Vite late output plugins are rejected for single and multiple output configurations", () => {
  const plugins = [
    { name: "output-transform", renderChunk: () => "changed output" },
  ];
  for (const output of [
    { plugins },
    [{ plugins }],
    { plugins: plugins[0] },
    () => ({ plugins }),
  ])
    expect(() =>
      resolvedViteTarget({
        build: { target: "node20.19", rolldownOptions: { output } },
      }),
    ).toThrow();
  for (const key of ["banner", "footer", "intro", "outro"])
    for (const value of [() => "custom output", "custom output"])
      expect(() =>
        resolvedViteTarget({
          build: {
            target: "node20.19",
            rolldownOptions: { output: { [key]: value } },
          },
        }),
      ).toThrow("Vite output addons");
  expect(
    resolvedViteTarget({
      build: {
        target: "node20.19",
        rolldownOptions: { output: [{ plugins: [] }] },
      },
    }),
  ).toEqual({ type: "javascript", targets: ["node20.19"] });
});
