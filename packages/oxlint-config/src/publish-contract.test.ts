/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import {
  checkPublishContract,
  parsePublishContract,
  publishConfigOverrideKeys,
  resolveManifestContract,
} from "./publish-contract";

const policy = { node: "22.12.0", typescript: "6.0.3" };
const target = { type: "javascript", targets: ["es2022", "node22"] } as const;
const manifest = {
  name: "@example/library",
  type: "module",
  engines: { node: ">=20" },
  peerDependencies: { typescript: ">=6.0.3 <8", react: ">=18 <20" },
  main: "./dist/index.cjs",
  module: "./dist/index.js",
  types: "./dist/index.d.ts",
  typings: "./dist/legacy.d.ts",
  typesVersions: { "*": { "*": ["dist/*"] } },
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      require: "./dist/index.cjs",
    },
    "./optional": ["./dist/optional.js", null],
  },
  bin: { library: "./dist/cli.js" },
};
const baseline = resolveManifestContract({ packer: "pnpm", manifest, target });
const check = (actual: unknown, contract: unknown = baseline) =>
  checkPublishContract({
    packer: "pnpm",
    manifest: actual,
    target,
    contract,
    policy,
  });

const contractFields = [
  "engines",
  "peerDependencies",
  "target",
  "entryPoints",
] as const;

describe("published contract schema", () => {
  test("requires all closed fields and validates each input class", () => {
    expect(parsePublishContract(baseline)).toEqual(baseline);
    for (const field of contractFields) {
      const missing = Object.fromEntries(
        Object.entries(baseline).filter(([key]) => key !== field),
      );
      expect(() => parsePublishContract(missing)).toThrow();
      for (const value of [null, 3, "", []])
        expect(() =>
          parsePublishContract({ ...baseline, [field]: value }),
        ).toThrow();
    }
    expect(() => parsePublishContract({ ...baseline, extra: {} })).toThrow(
      "unsupported",
    );
    for (const invalidTarget of [
      { type: "unknown" },
      { type: "types-only", targets: [] },
      { type: "javascript" },
      { type: "javascript", targets: [] },
      { type: "javascript", targets: [" "] },
      { type: "javascript", targets: ["node22", 22] },
      { type: "javascript", targets: ["es2022,node26"] },
      { type: "javascript", targets: ["node22"], platform: "node" },
    ])
      expect(() =>
        parsePublishContract({ ...baseline, target: invalidTarget }),
      ).toThrow();
    for (const invalidEntry of [
      { extra: "./dist/index.js" },
      { type: "unknown" },
      { main: null },
      { types: "" },
      { bin: { library: false } },
      { exports: { ".": { import: true } } },
      { exports: ["./index.js", 2] },
      { typesVersions: { "*": { "*": "./dist/index.d.ts" } } },
      { typesVersions: { "*": { "*": [null] } } },
    ])
      expect(() =>
        parsePublishContract({ ...baseline, entryPoints: invalidEntry }),
      ).toThrow();
    for (const field of ["engines", "peerDependencies"])
      for (const value of [false, null, ""])
        expect(() =>
          parsePublishContract({ ...baseline, [field]: { node: value } }),
        ).toThrow();
  });

  test("types-only and JavaScript without lowering remain distinct", () => {
    const declarations = resolveManifestContract({
      packer: "pnpm",
      manifest: { types: "./index.d.ts" },
      target: { type: "types-only" },
    });
    expect(declarations.target).toEqual({ type: "types-only" });
    expect(
      checkPublishContract({
        packer: "pnpm",
        manifest: { types: "./index.d.ts" },
        target: { type: "types-only" },
        contract: declarations,
        policy,
      }),
    ).toEqual([]);
    expect(
      resolveManifestContract({
        packer: "pnpm",
        manifest: {},
        target: { type: "javascript", targets: ["esnext"] },
      }).target,
    ).toEqual({ type: "javascript", targets: ["esnext"] });
    expect(() =>
      parsePublishContract({ ...declarations, target: undefined }),
    ).toThrow();
  });

  test("normalizes target sets but preserves ordered resolution branches", () => {
    expect(
      resolveManifestContract({
        packer: "pnpm",
        manifest,
        target: { type: "javascript", targets: ["node22", "es2022", "node22"] },
      }),
    ).toEqual(baseline);
    expect(
      check(manifest, {
        ...baseline,
        engines: { node: ">=20" },
        peerDependencies: { react: ">=18 <20", typescript: ">=6.0.3 <8" },
      }),
    ).toEqual([]);
    const reordered = {
      ...manifest,
      exports: {
        ...manifest.exports,
        ".": {
          require: "./dist/index.cjs",
          import: "./dist/index.js",
          types: "./dist/index.d.ts",
        },
      },
    };
    expect(check(reordered)).toMatchObject([{ field: "entryPoints.exports" }]);
    const typed = {
      typesVersions: { ">=6": { "*": ["v6/*"] }, "*": { "*": ["fallback/*"] } },
    };
    const committed = resolveManifestContract({
      packer: "pnpm",
      manifest: typed,
      target: { type: "types-only" },
    });
    expect(
      checkPublishContract({
        packer: "pnpm",
        manifest: {
          typesVersions: {
            "*": { "*": ["fallback/*"] },
            ">=6": { "*": ["v6/*"] },
          },
        },
        target: { type: "types-only" },
        contract: committed,
        policy,
      }),
    ).toMatchObject([{ field: "entryPoints.typesVersions" }]);
  });
});

describe("actual published manifest projection", () => {
  test("applies supported overrides and retains both declaration fields", () => {
    const actual = resolveManifestContract({
      packer: "pnpm",
      manifest: {
        ...manifest,
        typings: "./source/legacy.d.ts",
        publishConfig: {
          access: "public",
          registry: "https://registry.npmjs.org",
          exports: { ".": "./published.js" },
          main: "./published.cjs",
          module: "./published.js",
          types: "./published.d.ts",
          typings: "./published-legacy.d.ts",
          bin: { published: "./published-cli.js" },
          typesVersions: { "*": { "*": ["./published.d.ts"] } },
        },
      },
      target,
    });
    expect(actual.engines).toEqual(manifest.engines);
    expect(actual.peerDependencies).toEqual(manifest.peerDependencies);
    expect(actual.entryPoints).toEqual({
      type: "module",
      exports: { ".": "./published.js" },
      main: "./published.cjs",
      module: "./published.js",
      types: "./published.d.ts",
      typings: "./published-legacy.d.ts",
      bin: { published: "./published-cli.js" },
      typesVersions: { "*": { "*": ["./published.d.ts"] } },
    });
    expect(
      resolveManifestContract({
        packer: "pnpm",
        manifest: {
          name: "@example/cli",
          bin: "./cli.js",
        },
        target,
      }).entryPoints.bin,
    ).toEqual({ cli: "./cli.js" });
    expect(() =>
      resolveManifestContract({
        packer: "pnpm",
        manifest: { bin: "./cli.js" },
        target,
      }),
    ).toThrow("package name");
    expect(() =>
      resolveManifestContract({
        packer: "pnpm",
        manifest: {
          name: "@example/cli",
          bin: "./cli.js",
          publishConfig: { name: null },
        },
        target,
      }),
    ).toThrow("publishConfig.name");
  });

  test("fails on unsupported surfaces and malformed overrides instead of guessing", () => {
    for (const key of [
      "directory",
      "peerDependencies",
      "engines",
      "name",
      "type",
      "imports",
      "files",
      "os",
      "cpu",
      "libc",
      "tag",
      "provenance",
      "executableFiles",
      "unknown",
    ])
      expect(() =>
        resolveManifestContract({
          packer: "pnpm",
          manifest: { ...manifest, publishConfig: { [key]: {} } },
          target,
        }),
      ).toThrow("publishConfig");
    for (const key of ["browser", "esnext", "es2015", "unpkg", "umd:main"])
      for (const location of ["root", "publishConfig"])
        expect(() =>
          resolveManifestContract({
            packer: "pnpm",
            manifest:
              location === "root"
                ? { ...manifest, [key]: "./alternate.js" }
                : { ...manifest, publishConfig: { [key]: "./alternate.js" } },
            target,
          }),
        ).toThrow("unsupported");
    for (const malformed of [null, [], "public", 1])
      expect(() =>
        resolveManifestContract({
          packer: "pnpm",
          manifest: { ...manifest, publishConfig: malformed },
          target,
        }),
      ).toThrow();
    for (const malformed of [null, false, { node: null }])
      expect(() =>
        resolveManifestContract({
          packer: "pnpm",
          manifest: { ...manifest, publishConfig: { engines: malformed } },
          target,
        }),
      ).toThrow();
    expect(() =>
      resolveManifestContract({
        packer: "pnpm",
        manifest: { engines: null },
        target,
      }),
    ).toThrow();
    expect(() =>
      resolveManifestContract({
        packer: "pnpm",
        manifest: { peerDependencies: null },
        target,
      }),
    ).toThrow();
  });

  test("every captured field mutation or removal requires a contract update", () => {
    const mutations = {
      engines: { ...manifest, engines: { node: ">=22" } },
      peerDependencies: {
        ...manifest,
        peerDependencies: { typescript: ">=6.0.3 <9" },
      },
      "entryPoints.type": { ...manifest, type: "commonjs" },
      "entryPoints.main": { ...manifest, main: "./changed.cjs" },
      "entryPoints.module": { ...manifest, module: "./changed.js" },
      "entryPoints.types": { ...manifest, types: "./changed.d.ts" },
      "entryPoints.typings": { ...manifest, typings: "./changed-legacy.d.ts" },
      "entryPoints.typesVersions": {
        ...manifest,
        typesVersions: { "*": { "*": ["changed/*"] } },
      },
      "entryPoints.exports": { ...manifest, exports: { ".": "./changed.js" } },
      "entryPoints.bin.library": {
        ...manifest,
        bin: { library: "./changed-cli.js" },
      },
    };
    const exercised = new Set<string>();
    for (const [field, actual] of Object.entries(mutations)) {
      exercised.add(field);
      expect(
        check(actual).some(
          (diagnostic) =>
            diagnostic.field === field ||
            diagnostic.field.startsWith(`${field}.`),
        ),
      ).toBe(true);
      const updated = resolveManifestContract({
        packer: "pnpm",
        manifest: actual,
        target,
      });
      expect(check(actual, updated)).toEqual([]);
    }
    expect(
      [
        ...new Set(
          [...exercised]
            .filter((field) => field.startsWith("entryPoints."))
            .map((field) => field.split(".").slice(0, 2).join(".")),
        ),
      ].sort(),
    ).toEqual(
      Object.keys(baseline.entryPoints)
        .map((key) => `entryPoints.${key}`)
        .sort(),
    );
    expect(Object.keys(baseline).sort()).toEqual([...contractFields].sort());
    for (const field of [
      "engines",
      "peerDependencies",
      "type",
      "main",
      "module",
      "types",
      "typings",
      "typesVersions",
      "exports",
      "bin",
    ])
      expect(
        check(
          Object.fromEntries(
            Object.entries(manifest).filter(([key]) => key !== field),
          ),
        ),
      ).not.toEqual([]);
    expect(
      checkPublishContract({
        packer: "pnpm",
        manifest,
        target: { type: "javascript", targets: ["es2020"] },
        contract: baseline,
        policy,
      }),
    ).toMatchObject([{ field: "target.targets" }]);
    const published = {
      ...manifest,
      publishConfig: { main: "./published.cjs" },
    };
    const publishedContract = resolveManifestContract({
      packer: "pnpm",
      manifest: published,
      target,
    });
    expect(
      check({ ...published, main: "./source-only.cjs" }, publishedContract),
    ).toEqual([]);
    expect(
      check(
        { ...published, publishConfig: { main: "./changed.cjs" } },
        publishedContract,
      ),
    ).toMatchObject([{ field: "entryPoints.main" }]);
  });

  test("JSON object keys are retained as data during projection and comparison", () => {
    const peers: unknown = JSON.parse(
      '{"__proto__":"*","typescript":">=6.0.3 <8"}',
    );
    const actual = resolveManifestContract({
      packer: "pnpm",
      manifest: { peerDependencies: peers },
      target,
    });
    expect(Object.hasOwn(actual.peerDependencies, "__proto__")).toBe(true);
    expect(
      checkPublishContract({
        packer: "pnpm",
        manifest: { peerDependencies: { typescript: ">=6.0.3 <8" } },
        target,
        contract: actual,
        policy,
      }),
    ).toMatchObject([{ field: "peerDependencies.__proto__" }]);
  });
});

describe("consumer compatibility policy", () => {
  test("supports Node22 and consumer TS6 without banning wider peer support", () => {
    for (const node of [undefined, "*", ">=20", "^22", "^20 || ^22"])
      for (const typescript of [
        undefined,
        "*",
        "^6",
        ">=6.0.3 <8",
        "6.0.3 || ^7",
      ]) {
        const actual = {
          ...(node === undefined ? {} : { engines: { node } }),
          ...(typescript === undefined
            ? {}
            : { peerDependencies: { typescript } }),
        };
        const committed = resolveManifestContract({
          packer: "pnpm",
          manifest: actual,
          target,
        });
        expect(check(actual, committed)).toEqual([]);
      }
  });

  test("a contract update cannot permit incompatible engines, peers or runtime targets", () => {
    for (const node of ["26.x", ">=26", ">22.12.0", "<22", "latest"]) {
      const actual = { engines: { node } };
      expect(
        check(
          actual,
          resolveManifestContract({ packer: "pnpm", manifest: actual, target }),
        ),
      ).toMatchObject([{ field: "engines.node" }]);
    }
    for (const typescript of ["^7", ">=7", "<6", ">6.0.3", "latest"])
      expect(
        check(
          { peerDependencies: { typescript } },
          resolveManifestContract({
            packer: "pnpm",
            manifest: { peerDependencies: { typescript } },
            target,
          }),
        ),
      ).toMatchObject([{ field: "peerDependencies.typescript" }]);
    for (const peer of ["bun", "bun-types", "@types/bun", "@typescript/native"])
      expect(
        check(
          { peerDependencies: { [peer]: "*" } },
          resolveManifestContract({
            packer: "pnpm",
            manifest: { peerDependencies: { [peer]: "*" } },
            target,
          }),
        ),
      ).toMatchObject([{ field: `peerDependencies.${peer}` }]);
    const bun = { engines: { bun: "*" } };
    expect(
      check(
        bun,
        resolveManifestContract({ packer: "pnpm", manifest: bun, target }),
      ),
    ).toMatchObject([{ field: "engines.bun" }]);
    for (const runtime of [
      "node26",
      "node26.0.0",
      "NODE26",
      "node22.13",
      "node026",
      "bun",
      "bun1.4.3",
      "BUN1",
    ])
      expect(
        checkPublishContract({
          packer: "pnpm",
          manifest: {},
          target: { type: "javascript", targets: [runtime] },
          contract: resolveManifestContract({
            packer: "pnpm",
            manifest: {},
            target: { type: "javascript", targets: [runtime] },
          }),
          policy,
        }),
      ).toMatchObject([{ field: "target" }]);
    for (const runtime of ["node20", "node22", "node22.12", "es2022"])
      expect(
        checkPublishContract({
          packer: "pnpm",
          manifest: {},
          target: { type: "javascript", targets: [runtime] },
          contract: resolveManifestContract({
            packer: "pnpm",
            manifest: {},
            target: { type: "javascript", targets: [runtime] },
          }),
          policy,
        }),
      ).toEqual([]);
  });

  test("consumer policy pins must be exact stable releases from the selected major", () => {
    for (const node of ["22.x", "^22.12.0", "26.0.0", "22.12.0-rc.1"])
      expect(() =>
        checkPublishContract({
          packer: "pnpm",
          manifest,
          target,
          contract: baseline,
          policy: { ...policy, node },
        }),
      ).toThrow("consumer policy");
    for (const typescript of ["6.x", "^6.0.3", "7.0.2", "6.0.3-rc.1"])
      expect(() =>
        checkPublishContract({
          packer: "pnpm",
          manifest,
          target,
          contract: baseline,
          policy: { ...policy, typescript },
        }),
      ).toThrow("consumer policy");
  });
});

test("npm contracts reject every differing supported override and accept structural equality", () => {
  const publishConfig = Object.fromEntries(
    publishConfigOverrideKeys.map((key) => [key, manifest[key]]),
  );
  const equal = {
    ...manifest,
    publishConfig: {
      ...publishConfig,
      bin: { library: "./dist/cli.js" },
      exports: manifest.exports,
    },
  };
  expect(
    resolveManifestContract({ packer: "npm", manifest: equal, target }),
  ).toEqual(baseline);
  expect(
    checkPublishContract({
      packer: "npm",
      manifest: equal,
      target,
      contract: baseline,
      policy,
    }),
  ).toEqual([]);
  const bins = {
    ...manifest,
    bin: { first: "./first.js", second: "./second.js" },
  };
  expect(
    resolveManifestContract({
      packer: "npm",
      manifest: {
        ...bins,
        publishConfig: { bin: { second: "./second.js", first: "./first.js" } },
      },
      target,
    }),
  ).toEqual(resolveManifestContract({ packer: "npm", manifest: bins, target }));
  expect(() =>
    resolveManifestContract({
      packer: "npm",
      manifest: {
        ...manifest,
        publishConfig: {
          exports: {
            ...manifest.exports,
            ".": {
              require: "./dist/index.cjs",
              import: "./dist/index.js",
              types: "./dist/index.d.ts",
            },
          },
        },
      },
      target,
    }),
  ).toThrow("publishConfig.exports");
  expect(() =>
    resolveManifestContract({
      packer: "npm",
      manifest: {
        ...manifest,
        typesVersions: {
          ">=6": { "*": ["v6/*"] },
          "*": { "*": ["fallback/*"] },
        },
        publishConfig: {
          typesVersions: {
            "*": { "*": ["fallback/*"] },
            ">=6": { "*": ["v6/*"] },
          },
        },
      },
      target,
    }),
  ).toThrow("publishConfig.typesVersions");
  for (const key of publishConfigOverrideKeys) {
    const changed = { ...manifest, publishConfig: { [key]: "./different.js" } };
    for (const operation of [
      () =>
        resolveManifestContract({ packer: "npm", manifest: changed, target }),
      () =>
        checkPublishContract({
          packer: "npm",
          manifest: changed,
          target,
          contract: baseline,
          policy,
        }),
    ])
      expect(operation).toThrow(
        `npm pack does not apply differing publishConfig.${key}`,
      );
  }
  expect(() =>
    resolveManifestContract({
      packer: "npm",
      manifest: { publishConfig: { main: "./index.js" } },
      target,
    }),
  ).toThrow("publishConfig.main");
});
