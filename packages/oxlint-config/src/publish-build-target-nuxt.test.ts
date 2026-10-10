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

import {
  resolvedNuxtTarget,
  resolveNuxtPublishTarget,
} from "./publish-build-target-nuxt";
import {
  isNuxtModuleTargetHook,
  nuxtModuleTarget,
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
        typeof module.nuxtModuleTarget !== "function" ||
        !("isNuxtModuleTargetHook" in module) ||
        typeof module.isNuxtModuleTargetHook !== "function"
      )
        throw new Error(
          "Built Nuxt helper must export its callback and recognizer",
        );
      return module;
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
