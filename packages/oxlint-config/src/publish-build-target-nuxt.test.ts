import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import packageMetadata from "../package.json";
import {
  resolvedNuxtTarget,
  resolveNuxtPublishTarget,
} from "./publish-build-target-nuxt";
import {
  isNuxtModuleTargetHook,
  nuxtModuleTarget,
  nuxtModuleTargetTargets,
} from "./publish-build-target-nuxt-helper";

test("Nuxt module and runtime targets are resolved independently", () => {
  expect(
    resolvedNuxtTarget({
      rollup: { esbuild: { target: "es2022" } },
      entries: [
        { builder: "rollup" },
        { builder: "mkdist", esbuild: { jsx: "automatic" } },
      ],
    }),
  ).toEqual({ type: "javascript", targets: ["es2022", "esnext"] });
  for (const builder of ["copy", "untyped", "other"])
    expect(() => resolvedNuxtTarget({ entries: [{ builder }] })).toThrow(
      "builder",
    );
});

test("Nuxt output plugins and late transforms cannot escape target capture", () => {
  for (const hook of [
    "renderChunk",
    "generateBundle",
    "writeBundle",
    "transform",
  ]) {
    expect(() =>
      resolvedNuxtTarget({
        entries: [{ builder: "rollup" }],
        rollup: {
          esbuild: { target: "es2022" },
          plugins: [{ name: "custom-output", [hook]: () => undefined }],
        },
      }),
    ).toThrow("Unreviewed Nuxt output plugins");
    expect(() =>
      resolvedNuxtTarget({
        entries: [{ builder: "mkdist", [hook]: () => undefined }],
        rollup: {},
      }),
    ).toThrow("Unreviewed Nuxt output transform");
  }
  expect(() =>
    resolvedNuxtTarget({
      entries: [{ builder: "rollup" }],
      rollup: {},
      hooks: { "rollup:options": () => undefined },
    }),
  ).toThrow("Unreviewed Nuxt output transform");
  const hidden = { esbuild: { target: "es2022" } };
  Object.defineProperty(hidden, "plugins", {
    value: [{ name: "late-output" }],
  });
  expect(() =>
    resolvedNuxtTarget({ entries: [{ builder: "rollup" }], rollup: hidden }),
  ).toThrow("Unreviewed Nuxt output plugins");
});

test("Nuxt isolated interception stops before cleanup and output writes", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nuxt-target-"));
  const write = (file: string, value: string) => {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), value);
  };
  try {
    write(
      "package.json",
      JSON.stringify({ name: "example-nuxt", type: "module" }),
    );
    for (const [name, version, entry] of [
      ["@nuxt/module-builder", "1.0.3", "dist/index.mjs"],
      ["unbuild", "3.6.1", "dist/index.mjs"],
      ["mkdist", "2.4.1", "dist/index.mjs"],
      ["jiti", "2.7.0", "index.cjs"],
    ])
      write(
        `node_modules/${name}/package.json`,
        JSON.stringify({
          name,
          version,
          type: "module",
          exports: `./${entry}`,
        }),
      );
    write(
      "node_modules/@nuxt/module-builder/dist/index.mjs",
      `export const build={async run(context){const {build}=await import('unbuild');await build(context.args.cwd,false,{entries:[{builder:'rollup'},{builder:'mkdist'}],rollup:{esbuild:{target:'esnext'}},hooks:{}})}};`,
    );
    write("node_modules/mkdist/dist/index.mjs", "export {};\n");
    write(
      "node_modules/jiti/index.cjs",
      "module.exports=()=>({import:async()=>({})});\n",
    );
    write(
      "node_modules/unbuild/dist/index.mjs",
      `import{rmSync,writeFileSync}from'node:fs';import path from'node:path';export const build=async(root,stub,input)=>{const hooks={};const context={options:input,hooks:{hook(name,callback){(hooks[name]??=[]).push(callback)}}};for(const[name,callback]of Object.entries(input.hooks))context.hooks.hook(name,callback);for(const callback of hooks['build:prepare']??[])await callback(context);for(const callback of hooks['build:before']??[])await callback(context);rmSync(path.join(root,'dist'),{recursive:true,force:true});writeFileSync(path.join(root,'built.txt'),'built');};`,
    );
    write("dist/existing.txt", "keep existing output\n");
    const alias = path.join(directory, "directory-alias");
    symlinkSync(directory, alias, "dir");
    for (const input of [directory, realpathSync(directory), alias])
      expect(resolveNuxtPublishTarget(input)).toEqual({
        type: "javascript",
        targets: ["esnext"],
      });
    expect(
      readFileSync(path.join(directory, "dist/existing.txt"), "utf8"),
    ).toBe("keep existing output\n");
    expect(existsSync(path.join(directory, "built.txt"))).toBe(false);
    const unbuildPath = path.join(
      directory,
      "node_modules/unbuild/dist/index.mjs",
    );
    const unbuildSource = readFileSync(unbuildPath, "utf8");
    writeFileSync(
      unbuildPath,
      unbuildSource.replace(
        "for(const callback of hooks['build:before']??[])",
        "context.options.rollup.plugins=[{name:'late-output',renderChunk(){return 'changed'}}];for(const callback of hooks['build:before']??[])",
      ),
    );
    expect(() => resolveNuxtPublishTarget(directory)).toThrow(
      "Unreviewed Nuxt output plugins",
    );
    expect(existsSync(path.join(directory, "built.txt"))).toBe(false);
    writeFileSync(unbuildPath, unbuildSource);
    write(
      "node_modules/@nuxt/module-builder/dist/constructor/index.mjs",
      readFileSync(
        path.join(
          directory,
          "node_modules/@nuxt/module-builder/dist/index.mjs",
        ),
        "utf8",
      ),
    );
    write(
      "node_modules/@nuxt/module-builder/dist/index.mjs",
      "export {build} from './constructor/index.mjs';\n",
    );
    expect(() => resolveNuxtPublishTarget(alias)).toThrow(
      "Unexpected Nuxt unbuild import parent",
    );
    expect(
      readFileSync(path.join(directory, "dist/existing.txt"), "utf8"),
    ).toBe("keep existing output\n");
    expect(existsSync(path.join(directory, "built.txt"))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Nuxt helper targets every actual JavaScript entry and preserves entry layout", () => {
  const entries = [
    {
      input: "/project/src/module",
      builder: "rollup",
      outDir: "/project/dist",
    },
    {
      input: "/project/src/runtime",
      builder: "mkdist",
      outDir: "/project/dist/runtime",
      ext: "js",
      esbuild: { jsx: "automatic", jsxImportSource: "vue", target: ["esnext"] },
    },
  ];
  const context = {
    options: {
      entries,
      rollup: { esbuild: { target: ["esnext"], jsx: "preserve" } },
    },
  };
  const before = nuxtModuleTarget("es2022");
  expect(isNuxtModuleTargetHook(before)).toBe(true);
  expect(isNuxtModuleTargetHook(() => undefined)).toBe(false);
  before(context);
  expect(context.options.rollup.esbuild).toEqual({
    target: ["es2022"],
    jsx: "preserve",
  });
  expect(entries).toEqual([
    {
      input: "/project/src/module",
      builder: "rollup",
      outDir: "/project/dist",
    },
    {
      input: "/project/src/runtime",
      builder: "mkdist",
      outDir: "/project/dist/runtime",
      ext: "js",
      esbuild: { jsx: "automatic", jsxImportSource: "vue", target: ["es2022"] },
    },
  ]);
});

test("Nuxt helper supplies an absent runtime target", () => {
  const context = {
    options: {
      entries: [{ builder: "mkdist", esbuild: { jsx: "automatic" } }],
      rollup: { esbuild: { target: "esnext" } },
    },
  };
  nuxtModuleTarget("es2022")(context);
  expect(resolvedNuxtTarget(context.options)).toEqual({
    type: "javascript",
    targets: ["es2022"],
  });
});

const builtEsmHelper = fileURLToPath(
  new URL("../dist/publish-build-target-nuxt-helper.mjs", import.meta.url),
);
const builtCjsHelper = fileURLToPath(
  new URL("../dist/publish-build-target-nuxt-helper.cjs", import.meta.url),
);
test.skipIf(
  process.env["CI"] !== "true" &&
    (!existsSync(builtEsmHelper) || !existsSync(builtCjsHelper)),
)(
  "built Nuxt ESM and CommonJS helpers recognize each other's callbacks",
  async () => {
    const esm: unknown = await import(pathToFileURL(builtEsmHelper).href);
    const cjs: unknown = createRequire(import.meta.url)(builtCjsHelper);
    const helper = (module: unknown) => {
      if (
        typeof module !== "object" ||
        module === null ||
        !("nuxtModuleTarget" in module) ||
        !("isNuxtModuleTargetHook" in module)
      )
        throw new Error(
          "Built Nuxt helper must export its callback and recognizer",
        );
      const {
        nuxtModuleTarget: makeTarget,
        isNuxtModuleTargetHook: recognizeTarget,
      } = module;
      if (
        typeof makeTarget !== "function" ||
        typeof recognizeTarget !== "function"
      )
        throw new Error("Built Nuxt helper exports must be functions");
      return {
        nuxtModuleTarget: makeTarget,
        isNuxtModuleTargetHook: recognizeTarget,
      };
    };
    const esmHelper = helper(esm);
    const cjsHelper = helper(cjs);
    const directory = mkdtempSync(path.join(tmpdir(), "nuxt-dual-helper-"));
    try {
      const esmConfig = path.join(directory, "build.config.mjs");
      const cjsConfig = path.join(directory, "build.config.cjs");
      writeFileSync(
        esmConfig,
        `import {nuxtModuleTarget} from ${JSON.stringify(pathToFileURL(builtEsmHelper).href)}; export default {hooks:{'build:before':nuxtModuleTarget('es2022')}};`,
      );
      writeFileSync(
        cjsConfig,
        `const {nuxtModuleTarget}=require(${JSON.stringify(builtCjsHelper)}); module.exports={hooks:{'build:before':nuxtModuleTarget('es2022')}};`,
      );
      const esmHook: unknown = (await import(pathToFileURL(esmConfig).href))
        .default.hooks["build:before"];
      const cjsHook: unknown = createRequire(import.meta.url)(cjsConfig).hooks[
        "build:before"
      ];
      expect(esmHelper.isNuxtModuleTargetHook(cjsHook)).toBe(true);
      expect(cjsHelper.isNuxtModuleTargetHook(esmHook)).toBe(true);
      expect(
        Object.getOwnPropertyDescriptor(
          esmHook,
          Symbol.for("@stll/oxlint-config.build-target.nuxt"),
        ),
      ).toMatchObject({
        enumerable: false,
        configurable: false,
        writable: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("Nuxt helper rejects unsupported entry builders and transform shapes", () => {
  for (const builder of ["copy", "untyped", "other"])
    expect(() =>
      nuxtModuleTarget("es2022")({
        options: { entries: [{ builder }], rollup: {} },
      }),
    ).toThrow("builder");
  expect(() => nuxtModuleTarget([])).toThrow("target");
  expect(() =>
    nuxtModuleTarget("es2022")({
      options: { entries: [{ builder: "mkdist", esbuild: [] }], rollup: {} },
    }),
  ).toThrow("transform");
});

test("Nuxt target markers contain frozen data and never invoke callback or property accessors", () => {
  const observation = { invocations: 0 };
  const foreign = () => {
    observation.invocations++;
  };
  const brand = Symbol.for("@stll/oxlint-config.build-target.nuxt");
  Object.defineProperty(foreign, brand, {
    value: Object.freeze({ version: 1, targets: Object.freeze(["es2022"]) }),
  });
  expect(nuxtModuleTargetTargets(foreign)).toEqual(["es2022"]);
  expect(isNuxtModuleTargetHook(foreign)).toBe(true);
  expect(observation.invocations).toBe(0);
  for (const marker of [
    { version: 1, targets: ["es2022"] },
    Object.freeze({ version: 1, targets: ["es2022"] }),
    Object.freeze({ version: 2, targets: Object.freeze(["es2022"]) }),
    Object.freeze({ version: 1, targets: Object.freeze([]) }),
    Object.freeze({
      version: 1,
      targets: Object.freeze(["es2022"]),
      extra: true,
    }),
    Object.freeze({
      version: 1,
      get targets() {
        observation.invocations++;
        return Object.freeze(["es2022"]);
      },
    }),
  ]) {
    const hook = () => {
      observation.invocations++;
    };
    Object.defineProperty(hook, brand, { value: marker });
    expect(nuxtModuleTargetTargets(hook)).toBeUndefined();
    expect(isNuxtModuleTargetHook(hook)).toBe(false);
  }
  expect(observation.invocations).toBe(0);
});

test("freshly loaded foreign branded hooks are replaced by the installed canonical target hook", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nuxt-canonical-target-"));
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), content);
  };
  try {
    write(
      "package.json",
      JSON.stringify({ name: "example-nuxt", type: "module" }),
    );
    for (const [name, version, entry] of [
      ["@nuxt/module-builder", "1.0.3", "dist/index.mjs"],
      ["unbuild", "3.6.1", "dist/index.mjs"],
      ["mkdist", "2.4.1", "dist/index.mjs"],
      ["jiti", "2.7.0", "index.cjs"],
    ])
      write(
        `node_modules/${name}/package.json`,
        JSON.stringify({
          name,
          version,
          type: "module",
          exports: `./${entry}`,
        }),
      );
    write(
      "node_modules/@stll/oxlint-config/package.json",
      JSON.stringify({
        name: "@stll/oxlint-config",
        version: packageMetadata.version,
        type: "module",
        exports: { "./build-target": "./dist/helper.mjs" },
      }),
    );
    write(
      "node_modules/@stll/oxlint-config/dist/helper.mjs",
      `const record=value=>typeof value==='object'&&value!==null&&!Array.isArray(value);const targetHookBrand=Symbol.for('@stll/oxlint-config.build-target.nuxt');const targetHookVersion=1;export const nuxtModuleTarget=${nuxtModuleTarget.toString()};export const nuxtModuleTargetTargets=${nuxtModuleTargetTargets.toString()};`,
    );
    write("node_modules/mkdist/dist/index.mjs", "export {};\n");
    write(
      "node_modules/jiti/index.cjs",
      `const path=require('node:path');const {pathToFileURL}=require('node:url');let loads=0;module.exports=root=>({import:async(file)=>file==='./build.config'?(await import(pathToFileURL(path.join(root,'build.config.mjs')).href+'?load='+loads++)).default:import(file)});module.exports.createJiti=module.exports;`,
    );
    write(
      "node_modules/@nuxt/module-builder/dist/index.mjs",
      `export const build={async run(context){const{build}=await import('unbuild');await build(context.args.cwd,false,{entries:[{builder:'rollup'},{builder:'mkdist',ext:'js',esbuild:{jsx:'automatic'}}],rollup:{esbuild:{target:'esnext',jsx:'preserve'}},hooks:{'build:before':context=>{context.options.rollup.esbuild.constructorOption='keep'}}})}};`,
    );
    write(
      "node_modules/unbuild/dist/index.mjs",
      `import{createJiti}from'jiti';export const build=async(root,stub,input)=>{const config=await createJiti(root).import('./build.config');const callbacks={};const hooks={hook(name,callback){(callbacks[name]??=[]).push(callback)},removeHook(name,callback){const index=(callbacks[name]??=[]).indexOf(callback);if(index!==-1)callbacks[name].splice(index,1)}};const context={options:{...input,hooks:{...input.hooks,...config.hooks}},hooks};for(const source of [input.hooks,config.hooks])for(const[name,callback]of Object.entries(source??{}))hooks.hook(name,callback);for(const callback of callbacks['build:prepare']??[])await callback(context);for(const callback of callbacks['build:before']??[]){await callback(context);if(context.options.rollup.esbuild.jsx!=='preserve'||context.options.entries[1].esbuild.jsx!=='automatic'||context.options.entries[1].ext!=='js')throw new Error('Unrelated build options changed')}throw new Error('Unexpected output write boundary');};`,
    );
    const foreignExecution = path.join(directory, "foreign-executed");
    const foreignConfig = `import{writeFileSync}from'node:fs';const foreign=context=>{writeFileSync(${JSON.stringify(foreignExecution)},'executed');context.options.rollup.esbuild.jsx='changed'};Object.defineProperty(foreign,Symbol.for('@stll/oxlint-config.build-target.nuxt'),{value:Object.freeze({version:1,targets:Object.freeze(['es2022'])})});export default{hooks:{'build:before':foreign}};`;
    write("build.config.mjs", foreignConfig);
    expect(resolveNuxtPublishTarget(directory)).toEqual({
      type: "javascript",
      targets: ["es2022"],
    });
    expect(existsSync(foreignExecution)).toBe(false);
    write("build.config.mjs", "export default {};\n");
    expect(resolveNuxtPublishTarget(directory)).toEqual({
      type: "javascript",
      targets: ["esnext"],
    });
    for (const name of ["build:before", "build:prepare", "build:done"]) {
      write(
        "build.config.mjs",
        `import{writeFileSync}from'node:fs';globalThis.__fixtureLoads=(globalThis.__fixtureLoads||0)+1;export default globalThis.__fixtureLoads===1?{}:{hooks:{${JSON.stringify(name)}:()=>writeFileSync(${JSON.stringify(foreignExecution)},'executed')}};`,
      );
      expect(() => resolveNuxtPublishTarget(directory)).toThrow(
        "Nuxt target configuration changed during loading",
      );
      expect(existsSync(foreignExecution)).toBe(false);
    }
    for (const later of [
      "{}",
      "{hooks:{'build:before':hook}}",
      "{hooks:{'build:before':hook,'build:done':()=>{}}}",
      "{hooks:{'build:before':foreign,'build:prepare':()=>{}}}",
    ]) {
      write(
        "build.config.mjs",
        `globalThis.__fixtureLoads=(globalThis.__fixtureLoads||0)+1;const hook=()=>{};Object.defineProperty(hook,Symbol.for('@stll/oxlint-config.build-target.nuxt'),{value:Object.freeze({version:1,targets:Object.freeze(['es2021'])})});${foreignConfig.replace("export default{hooks:{'build:before':foreign}};", `export default globalThis.__fixtureLoads===1?{hooks:{'build:before':foreign}}:${later};`)}`,
      );
      expect(() => resolveNuxtPublishTarget(directory)).toThrow(
        "Nuxt target configuration changed during loading",
      );
      expect(existsSync(foreignExecution)).toBe(false);
    }
    write(
      "build.config.mjs",
      foreignConfig.replace(
        "export default{hooks:",
        "globalThis.__fixtureLoads=(globalThis.__fixtureLoads||0)+1;export default globalThis.__fixtureLoads===1?{}:{hooks:",
      ),
    );
    expect(() => resolveNuxtPublishTarget(directory)).toThrow(
      "Nuxt target configuration changed during loading",
    );
    expect(existsSync(foreignExecution)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
