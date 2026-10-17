import { expect, test } from "bun:test";

import { assertPackedRuntimeImports } from "./publish-runtime-imports";

const fixture = (entries: Record<string, string>, manifest: unknown = {}) => {
  const files = new Map([
    ["package/package.json", JSON.stringify(manifest)],
    ...Object.entries(entries).map(
      ([path, source]) => [`package/${path}`, source] as const,
    ),
  ]);
  const members = new Set(files.keys());
  const regular = new Set(members);
  const reads: string[] = [];
  const checks: string[] = [];
  return {
    files,
    members,
    regular,
    reads,
    checks,
    options: {
      members,
      readSource: (path: string) => {
        reads.push(path);
        const source = files.get(path);
        return source === undefined
          ? Promise.reject(new Error(`Missing fixture source: ${path}`))
          : Promise.resolve(source);
      },
      assertRegular: (path: string) => {
        checks.push(path);
        return regular.has(path)
          ? Promise.resolve()
          : Promise.reject(new Error(`Not a regular fixture member: ${path}`));
      },
    },
  };
};

test("the published native-package command requires its local helper", async () => {
  const packed = fixture(
    {
      "scripts/build-native-pipeline-package.mjs":
        '#!/usr/bin/env node\nimport { readNativePackageInput } from "./native-script-contracts.mjs";',
    },
    {
      name: "@stll/anonymize",
      type: "module",
      bin: {
        "stella-anonymize-build-native-package":
          "./scripts/build-native-pipeline-package.mjs",
      },
    },
  );
  await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
    "native-script-contracts.mjs",
  );
  packed.files.set(
    "package/scripts/native-script-contracts.mjs",
    "export const readNativePackageInput = value => value;",
  );
  packed.members.add("package/scripts/native-script-contracts.mjs");
  packed.regular.add("package/scripts/native-script-contracts.mjs");
  await assertPackedRuntimeImports(packed.options);
});

const closureEntries = {
  "bin/entry.mjs":
    'import "../lib/import.mjs"; export { value } from "../lib/named.mjs"; export * from "../lib/star.mjs"; void import("../lib/dynamic.mjs");',
  "lib/import.mjs": 'import "./cycle.mjs";',
  "lib/cycle.mjs": 'import "./import.mjs";',
  "lib/named.mjs": "export const value = 1;",
  "lib/star.mjs": "export const other = 2;",
  "lib/dynamic.mjs": "export default 3;",
  "bin/common.cjs":
    'require("../lib/required"); require.resolve("../lib/resolved");',
  "lib/required/index.js": "module.exports = 1;",
  "lib/resolved.js": "module.exports = 2;",
};
const closureManifest = {
  type: "module",
  bin: { command: "./bin/entry.mjs" },
  main: "./bin/common.cjs",
  exports: {
    ".": {
      types: "./missing.d.mts",
      import: "./bin/entry.mjs",
      require: "./bin/common.cjs",
    },
  },
};

test("every required local member is necessary across the full static import graph", async () => {
  const complete = fixture(closureEntries, closureManifest);
  await assertPackedRuntimeImports(complete.options);
  for (const path of Object.keys(closureEntries)) {
    const incomplete = fixture(closureEntries, closureManifest);
    incomplete.members.delete(`package/${path}`);
    await expect(
      assertPackedRuntimeImports(incomplete.options),
    ).rejects.toThrow();
  }
});

test("non-entry scripts also require their static import closure", async () => {
  const packed = fixture({
    "lib/unreferenced.mjs": 'export * from "./missing.mjs";',
  });
  await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
    "missing.mjs",
  );
});

test("extensionless bin, main and export roots traverse extensionless intermediate modules", async () => {
  for (const manifest of [
    { type: "module", bin: { command: "./bin/entry" } },
    { type: "module", main: "./bin/entry" },
    { type: "module", exports: { ".": "./bin/entry" } },
  ]) {
    const entries = {
      "bin/entry": '#!/usr/bin/env node\nimport "./helper";',
      "bin/helper": 'export { value } from "./leaf.mjs";',
      "bin/leaf.mjs": "export const value = 1;",
    };
    const packed = fixture(entries, manifest);
    await assertPackedRuntimeImports(packed.options);
    expect(packed.reads).toContain("package/bin/helper");
    packed.members.delete("package/bin/leaf.mjs");
    await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
      "leaf.mjs",
    );
  }
});

test("CommonJS extension and index resolution does not authorize extensionless ESM imports", async () => {
  for (const operation of ["require", "require.resolve"]) {
    for (const target of [
      "helper.js",
      "helper.json",
      "helper.node",
      "helper/index.js",
      "helper/index.json",
      "helper/index.node",
    ]) {
      const packed = fixture(
        {
          "entry.cjs": `${operation}("./helper");`,
          [target]: target.endsWith(".js")
            ? "module.exports = 1;"
            : "opaque asset",
        },
        { main: "./entry.cjs" },
      );
      await assertPackedRuntimeImports(packed.options);
      expect(packed.checks).toContain(`package/${target}`);
      if (target.endsWith(".json") || target.endsWith(".node"))
        expect(packed.reads).not.toContain(`package/${target}`);
    }
  }
  for (const source of [
    'import "./helper";',
    'export * from "./helper";',
    'void import("./helper");',
  ]) {
    const packed = fixture(
      { "entry.mjs": source, "helper.js": "export const value = 1;" },
      { type: "module" },
    );
    await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
      "helper",
    );
  }
});

test("explicit JSON and native assets must be regular packed files but are never parsed", async () => {
  const packed = fixture({
    "entry.cjs": 'require("./data.json"); require.resolve("./binding.node");',
    "data.json": '{"text":"not JavaScript import syntax"}',
    "binding.node": "not parseable JavaScript",
  });
  await assertPackedRuntimeImports(packed.options);
  for (const path of ["data.json", "binding.node"]) {
    expect(packed.checks).toContain(`package/${path}`);
    expect(packed.reads).not.toContain(`package/${path}`);
    const nonregular = fixture({
      "entry.cjs": `require("./${path}");`,
      [path]: "opaque",
    });
    nonregular.regular.delete(`package/${path}`);
    await expect(
      assertPackedRuntimeImports(nonregular.options),
    ).rejects.toThrow("Not a regular");
  }
});

test("builtins, bare dependencies and computed dynamic imports have no local closure", async () => {
  const packed = fixture(
    {
      "entry.mjs":
        'import "node:fs"; import "external-package"; export * from "@scope/dependency"; const target = "./consumer-config.mjs"; void import(target);',
    },
    { type: "module" },
  );
  await assertPackedRuntimeImports(packed.options);
  expect(new Set(packed.checks)).toEqual(new Set(packed.members));
});

test("declaration extensions and type-only export conditions are not runtime modules", async () => {
  const packed = fixture(
    {
      "index.mjs": "export const value = 1;",
      "types.d.ts": "declare const value: unknown;",
      "types.d.mts": "declare const value: unknown;",
      "types.d.cts": "declare const value: unknown;",
    },
    {
      type: "module",
      exports: { ".": { types: "./absent.d.mts", import: "./index.mjs" } },
    },
  );
  await assertPackedRuntimeImports(packed.options);
  for (const path of ["types.d.ts", "types.d.mts", "types.d.cts"])
    expect(packed.reads).not.toContain(`package/${path}`);
});

test("shadowed CommonJS require identifiers do not manufacture dependencies", async () => {
  for (const source of [
    'function use(require) { return require("./absent.cjs"); }',
    'const use = require => require.resolve("./absent.cjs");',
    'function use() { const require = () => 1; return require("./absent.cjs"); }',
    'function require() {} require.resolve("./absent.cjs");',
    'try {} catch (require) { require("./absent.cjs"); }',
    '{ const require = () => 1; require("./absent.cjs"); }',
  ]) {
    await assertPackedRuntimeImports(fixture({ "entry.cjs": source }).options);
  }
  const outside = fixture({
    "entry.cjs":
      'function use(require) { require("./shadowed.cjs"); } require("./actual.cjs");',
  });
  await expect(assertPackedRuntimeImports(outside.options)).rejects.toThrow(
    "actual.cjs",
  );
});

test("missing declared entries, escaped paths and unresolved package mappings fail closed", async () => {
  for (const manifest of [
    { bin: "./absent" },
    { main: "./absent.js" },
    { exports: { ".": "./absent.mjs" } },
  ])
    await expect(
      assertPackedRuntimeImports(fixture({}, manifest).options),
    ).rejects.toThrow("absent");
  for (const specifier of [
    "../outside.mjs",
    "/absolute.mjs",
    "file:///outside.mjs",
    "#unmapped",
  ])
    await expect(
      assertPackedRuntimeImports(
        fixture({ "entry.mjs": `import "${specifier}";` }, { type: "module" })
          .options,
      ),
    ).rejects.toThrow();
});

test("literal package-local import mappings preserve the same closure requirement", async () => {
  const packed = fixture(
    {
      "entry.mjs": 'import "#helper";',
      "helper.mjs": "export const value = 1;",
    },
    { type: "module", imports: { "#helper": "./helper.mjs" } },
  );
  await assertPackedRuntimeImports(packed.options);
  packed.members.delete("package/helper.mjs");
  await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
    "helper.mjs",
  );
});

test("regular-file validation covers entry scripts as well as dependencies", async () => {
  for (const path of ["package/bin/entry", "package/helper.mjs"]) {
    const packed = fixture(
      {
        "bin/entry": 'import "../helper.mjs";',
        "helper.mjs": "export const value = 1;",
      },
      { type: "module", bin: "./bin/entry" },
    );
    packed.regular.delete(path);
    await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
      "Not a regular",
    );
  }
});

test("package import conditions, arrays and concrete wildcard mappings retain every local branch", async () => {
  for (const mapping of [
    {
      "#helper": {
        node: "./node.mjs",
        default: ["./first.mjs", "./second.mjs"],
      },
    },
    {
      "#helper/*": {
        node: "./node-*.mjs",
        default: ["./first-*.mjs", "./second-*.mjs"],
      },
    },
  ]) {
    const wildcard = Object.keys(mapping).some((key) => key.includes("*"));
    const suffix = wildcard ? "-value" : "";
    const entries = {
      "entry.mjs": `import "${wildcard ? "#helper/value" : "#helper"}";`,
      [`node${suffix}.mjs`]: "export const value = 1;",
      [`first${suffix}.mjs`]: "export const value = 1;",
      [`second${suffix}.mjs`]: "export const value = 1;",
    };
    const packed = fixture(entries, { type: "module", imports: mapping });
    await assertPackedRuntimeImports(packed.options);
    for (const name of ["node", "first", "second"]) {
      const incomplete = fixture(entries, { type: "module", imports: mapping });
      incomplete.members.delete(`package/${name}${suffix}.mjs`);
      await expect(
        assertPackedRuntimeImports(incomplete.options),
      ).rejects.toThrow();
    }
  }
});

test("createRequire aliases resolve static local calls and resolve calls", async () => {
  for (const [entry, source] of [
    [
      "entry.mjs",
      'import { createRequire } from "node:module"; const localRequire = createRequire(import.meta.url); localRequire("./helper"); localRequire.resolve("./resolved");',
    ],
    [
      "entry.cjs",
      'const { createRequire } = require("node:module"); const localRequire = createRequire(__filename); localRequire("./helper"); localRequire.resolve("./resolved");',
    ],
  ]) {
    const entries = {
      [entry]: source,
      "helper.js": "module.exports = 1;",
      "resolved/index.js": "module.exports = 2;",
    };
    const packed = fixture(entries);
    await assertPackedRuntimeImports(packed.options);
    for (const path of ["helper.js", "resolved/index.js"]) {
      const incomplete = fixture(entries);
      incomplete.members.delete(`package/${path}`);
      await expect(
        assertPackedRuntimeImports(incomplete.options),
      ).rejects.toThrow();
    }
  }
});

test("ESM URL suffixes and encoded filename characters resolve without allowing encoded separators", async () => {
  const packed = fixture(
    {
      "entry.mjs": 'import "./helper%20file.mjs?query#fragment";',
      "helper file.mjs": "export const value = 1;",
    },
    { type: "module" },
  );
  await assertPackedRuntimeImports(packed.options);
  expect(packed.checks).toContain("package/helper file.mjs");
  for (const specifier of [
    "./nested%2fhelper.mjs",
    "./nested%2Fhelper.mjs",
    "./nested%5chelper.mjs",
    "./nested%5Chelper.mjs",
  ]) {
    const invalid = fixture(
      {
        "entry.mjs": `import "${specifier}";`,
        "nested/helper.mjs": "export const value = 1;",
      },
      { type: "module" },
    );
    await expect(assertPackedRuntimeImports(invalid.options)).rejects.toThrow();
  }
});

test("package-local imports use the nearest nested package scope", async () => {
  const entries = {
    "entry.mjs": 'import "#helper"; import "./nested/entry.mjs";',
    "root-helper.mjs": "export const value = 1;",
    "nested/package.json": JSON.stringify({
      type: "module",
      imports: { "#helper": "./nested-helper.mjs" },
    }),
    "nested/entry.mjs": 'import "#helper";',
    "nested/nested-helper.mjs": "export const value = 2;",
  };
  const manifest = {
    type: "module",
    imports: { "#helper": "./root-helper.mjs" },
  };
  await assertPackedRuntimeImports(fixture(entries, manifest).options);
  for (const path of ["root-helper.mjs", "nested/nested-helper.mjs"]) {
    const incomplete = fixture(entries, manifest);
    incomplete.members.delete(`package/${path}`);
    await expect(
      assertPackedRuntimeImports(incomplete.options),
    ).rejects.toThrow();
  }
});

test("cyclic package import mappings fail explicitly", async () => {
  for (const imports of [
    { "#a": "#a" },
    { "#a": "#b", "#b": "#a" },
    { "#a": { node: "#b" }, "#b": ["#a"] },
  ]) {
    const packed = fixture(
      { "entry.mjs": 'import "#a";' },
      { type: "module", imports },
    );
    await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
      /cycl/iu,
    );
  }
});

test("CommonJS directory resolution uses package main and its index fallback", async () => {
  for (const [main, target] of [
    ["actual.cjs", "helper/actual.cjs"],
    ["extensionless", "helper/extensionless"],
    ["missing.cjs", "helper/index.js"],
  ] as const) {
    const entries = {
      "entry.cjs": 'require("./helper"); require.resolve("./helper");',
      "helper/package.json": JSON.stringify({ main }),
      [target]: 'require("./leaf.cjs");',
      "helper/leaf.cjs": "module.exports = 1;",
    };
    const packed = fixture(entries);
    await assertPackedRuntimeImports(packed.options);
    expect(packed.checks).toContain(`package/${target}`);
    expect(packed.reads).toContain("package/helper/package.json");
    packed.members.delete("package/helper/leaf.cjs");
    await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
      "leaf.cjs",
    );
  }
});

test("declared entry roots cannot escape the package", async () => {
  for (const root of [
    "/outside.mjs",
    "../outside.mjs",
    "./nested/../../outside.mjs",
  ]) {
    for (const manifest of [
      { bin: root },
      { main: root },
      { exports: { ".": root } },
    ]) {
      await expect(
        assertPackedRuntimeImports(fixture({}, manifest).options),
      ).rejects.toThrow();
    }
  }
});

test("unshadowed module require properties preserve static local dependencies", async () => {
  for (const source of [
    'module.require("./helper");',
    'module["require"]("./helper");',
  ]) {
    const packed = fixture({
      "entry.cjs": source,
      "helper.js": "module.exports = 1;",
    });
    await assertPackedRuntimeImports(packed.options);
    packed.members.delete("package/helper.js");
    await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
      "helper",
    );
  }
  await assertPackedRuntimeImports(
    fixture({
      "entry.cjs":
        'function use(module) { module.require("./not-local.cjs"); }',
    }).options,
  );
});

test("legacy main resolution and exported URLs follow their distinct path rules", async () => {
  for (const main of ["./index", ".", ""]) {
    const packed = fixture(
      {
        "index.js": 'require("./helper.cjs");',
        "helper.cjs": "module.exports = 1;",
      },
      { main },
    );
    await assertPackedRuntimeImports(packed.options);
    packed.members.delete("package/helper.cjs");
    await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
      "helper.cjs",
    );
  }
  const packed = fixture(
    { "entry file.mjs": "export const value = 1;" },
    {
      type: "module",
      exports: { ".": "./entry%20file.mjs?query#fragment" },
    },
  );
  await assertPackedRuntimeImports(packed.options);
  expect(packed.checks).toContain("package/entry file.mjs");
});

test("computed literal require.resolve methods retain static local targets", async () => {
  for (const source of [
    'require["resolve"]("./helper");',
    'const loader = require; loader["resolve"]("./helper");',
  ]) {
    const packed = fixture({
      "entry.cjs": source,
      "helper.js": "module.exports = 1;",
    });
    await assertPackedRuntimeImports(packed.options);
    packed.members.delete("package/helper.js");
    await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
      "helper",
    );
  }
  await assertPackedRuntimeImports(
    fixture({
      "entry.cjs":
        'function use(require) { require["resolve"]("./not-local.cjs"); }',
    }).options,
  );
});

test("uninitialized CommonJS var redeclarations retain wrapper loader bindings", async () => {
  for (const source of [
    'var require; require("./helper");',
    'var module; module.require("./helper");',
    'var require, module; require.resolve("./helper"); module["require"]("./helper");',
    'if (true) { var require; require("./helper"); }',
  ]) {
    const packed = fixture({
      "entry.cjs": source,
      "helper.js": "module.exports = 1;",
    });
    await assertPackedRuntimeImports(packed.options);
    packed.members.delete("package/helper.js");
    await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
      "helper",
    );
  }
  await assertPackedRuntimeImports(
    fixture({
      "entry.cjs":
        'function use(require) { var require; require("./not-local.cjs"); }',
    }).options,
  );
});

test("CommonJS package-import mappings use exact URL resolution without extension fallback", async () => {
  for (const target of ["helper.js", "helper/index.js"]) {
    const packed = fixture(
      { "entry.cjs": 'require("#helper");', [target]: "module.exports = 1;" },
      { imports: { "#helper": "./helper" } },
    );
    await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
      "helper",
    );
  }
  const packed = fixture(
    {
      "entry.cjs": 'require("#helper");',
      "helper file.cjs": "module.exports = 1;",
    },
    { imports: { "#helper": "./helper%20file.cjs?query#fragment" } },
  );
  await assertPackedRuntimeImports(packed.options);
  expect(packed.checks).toContain("package/helper file.cjs");
});

test("expanding wildcard alias cycles reject without repeating the concrete specifier", async () => {
  for (const imports of [
    { "#loop/*": "#loop/prefix/*" },
    { "#loop/*": "#other/*", "#other/*": "#loop/prefix/*" },
  ]) {
    const packed = fixture(
      { "entry.mjs": 'import "#loop/value";' },
      { type: "module", imports },
    );
    await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
      /cycl/iu,
    );
  }
});

test("only lowercase JSON and native asset extensions are opaque", async () => {
  for (const extension of ["JSON", "NODE"]) {
    const entries = {
      "entry.cjs": `require("./helper.${extension}");`,
      [`helper.${extension}`]: 'require("./leaf.cjs");',
      "leaf.cjs": "module.exports = 1;",
    };
    const packed = fixture(entries);
    await assertPackedRuntimeImports(packed.options);
    expect(packed.reads).toContain(`package/helper.${extension}`);
    packed.members.delete("package/leaf.cjs");
    await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
      "leaf.cjs",
    );
  }
});

test("declared bins are scripts independently of executable name and extension", async () => {
  for (const [name, path] of [
    ["types", "bin/entry"],
    ["command", "bin/entry.node"],
  ] as const) {
    const entries = {
      [path]: '#!/usr/bin/env node\nrequire("../helper.cjs");',
      "helper.cjs": "module.exports = 1;",
    };
    const packed = fixture(entries, { bin: { [name]: `./${path}` } });
    await assertPackedRuntimeImports(packed.options);
    expect(packed.reads).toContain(`package/${path}`);
    packed.members.delete("package/helper.cjs");
    await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
      "helper.cjs",
    );
  }
});

test("ESM asset targets are required packed members without being parsed as JavaScript", async () => {
  for (const asset of ["style.css", "engine.wasm", "logo.svg"]) {
    const packed = fixture(
      { "entry.mjs": `import "./${asset}";`, [asset]: "opaque asset bytes" },
      {
        type: "module",
        exports: { ".": "./entry.mjs", "./asset": `./${asset}` },
      },
    );
    await assertPackedRuntimeImports(packed.options);
    expect(packed.checks).toContain(`package/${asset}`);
    expect(packed.reads).not.toContain(`package/${asset}`);
    packed.regular.delete(`package/${asset}`);
    await expect(assertPackedRuntimeImports(packed.options)).rejects.toThrow(
      "Not a regular",
    );
  }
});
