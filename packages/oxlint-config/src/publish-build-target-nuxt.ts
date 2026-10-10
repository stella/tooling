import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { PublishTarget } from "./publish-contract";

const supportedVersions = {
  "@nuxt/module-builder": "1.0.3",
  unbuild: "3.6.1",
  mkdist: "2.4.1",
} as const;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Only the reviewed builder and branded target hook may introduce executable build behavior. */
export const assertNuxtOutputOptions = (options: unknown) => {
  const visit = (value: unknown) => {
    if (typeof value === "function")
      throw new Error(
        "Unreviewed Nuxt output transform requires a supported target resolver",
      );
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if (value instanceof RegExp) return;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("Unsupported Nuxt output option prototype");
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor || !("value" in descriptor))
        throw new Error("Unsupported Nuxt output option property");
      const entry: unknown = descriptor.value;
      if (
        key === "plugins" &&
        entry !== undefined &&
        (!Array.isArray(entry) || entry.length > 0)
      )
        throw new Error(
          "Unreviewed Nuxt output plugins require a supported target resolver",
        );
      visit(entry);
    }
  };
  visit(options);
};

/** Read actual normalized entry targets, including mkdist's separate transform. */
export const resolvedNuxtTarget = (options: unknown): PublishTarget => {
  assertNuxtOutputOptions(options);
  if (
    !record(options) ||
    !Array.isArray(options["entries"]) ||
    options["entries"].length === 0
  )
    throw new Error("Nuxt must resolve at least one JavaScript entry");
  const emitted = new Set<string>();
  for (const entry of options["entries"]) {
    if (!record(entry)) throw new Error("Invalid resolved Nuxt entry");
    let transform: unknown;
    switch (entry["builder"]) {
      case "rollup":
        if (!record(options["rollup"]))
          throw new Error("Invalid Nuxt module options");
        transform = options["rollup"]["esbuild"];
        break;
      case "mkdist":
        transform = entry["esbuild"];
        break;
      default:
        throw new Error("Unsupported Nuxt JavaScript entry builder");
    }
    if (transform !== undefined && !record(transform))
      throw new Error("Invalid Nuxt JavaScript transform options");
    const target = record(transform) ? transform["target"] : undefined;
    if (target === undefined) {
      emitted.add("esnext");
      continue;
    }
    const targets = typeof target === "string" ? [target] : target;
    if (!Array.isArray(targets) || targets.length === 0)
      throw new Error("Unsupported resolved Nuxt JavaScript target");
    for (const item of targets) {
      if (typeof item !== "string" || item.length === 0)
        throw new Error("Unsupported resolved Nuxt JavaScript target");
      emitted.add(item);
    }
  }
  return { type: "javascript", targets: [...emitted].sort() };
};

// Run in a separate process: the loader only redirects the constructor's unbuild import.
const captureProgram = String.raw`
import { register } from 'node:module';
const payload = JSON.parse(process.argv[1]);
register(payload.loader, import.meta.url);
const jitiModule = await import(payload.jiti);
const createJiti = jitiModule.createJiti || jitiModule.default;
const jiti = createJiti(payload.directory);
const config = await jiti.import('./build.config', {try: true, default: true}) || {};
const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);
if (!record(config) || Object.keys(config).some(key => key !== 'hooks')) throw new Error('Nuxt build configuration only supports the declared target hook');
if (config.hooks !== undefined) {
  if (!record(config.hooks) || Object.keys(config.hooks).length !== 1 || !('build:before' in config.hooks)) throw new Error('Nuxt build configuration only supports the declared target hook');
  if (!payload.helper) throw new Error('Nuxt target helper must be installed at the same tooling version');
  const helper = await jiti.import(payload.helper, {default: false});
  if (!helper.isNuxtModuleTargetHook(config.hooks['build:before'])) throw new Error('Nuxt build configuration requires nuxtModuleTarget');
}
globalThis.__stllNuxtAbort = new Error('Nuxt target captured');
globalThis.__stllNuxtCapture = undefined;
const tool = await import(payload.tool);
try {
  await tool.build.run({args: {cwd: payload.directory, rootDir: '.', outDir: 'dist', sourcemap: false, stub: false}});
  throw new Error('Nuxt build did not reach the configuration boundary');
} catch (error) {
  if (error !== globalThis.__stllNuxtAbort) throw error;
}
console.log('__STLL_NUXT_TARGET__' + JSON.stringify(globalThis.__stllNuxtCapture));
`;

const captureShim = (unbuild: string) => `
import {build as actualBuild} from ${JSON.stringify(unbuild)};
export const build = (root, stub, input) => actualBuild(root, stub, {
  ...input,
  hooks: {
    ...input.hooks,
    'build:prepare': context => {
      // unbuild 3.6.1 normalizes entries before build:before, then cleans output.
      // Append after all registered config hooks so the target helper runs first.
      context.hooks.hook('build:before', final => {
        // The reviewed constructor owns its later hooks; user config accepts only nuxtModuleTarget.
        // Validate executable output options before projecting away functions for the capture.
        (${assertNuxtOutputOptions.toString()})({entries: final.options.entries, rollup: final.options.rollup});
        globalThis.__stllNuxtCapture = {
          entries: final.options.entries.map(entry => ({builder: entry.builder, esbuild: entry.esbuild})),
          rollup: {esbuild: final.options.rollup.esbuild}
        };
        throw globalThis.__stllNuxtAbort;
      });
    }
  }
});
`;

export const resolveNuxtPublishTarget = (directory: string): PublishTarget => {
  const canonicalDirectory = realpathSync(directory);
  const require = createRequire(path.join(canonicalDirectory, "package.json"));
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(canonicalDirectory, "package.json"), "utf8"),
  );
  if (
    !record(manifest) ||
    manifest["build"] !== undefined ||
    manifest["unbuild"] !== undefined ||
    (record(manifest["publishConfig"]) &&
      (manifest["publishConfig"]["build"] !== undefined ||
        manifest["publishConfig"]["unbuild"] !== undefined))
  )
    throw new Error(
      "Nuxt manifest build overrides require a supported target resolver",
    );
  const configs = ["ts", "mts", "cts", "js", "mjs", "cjs", "json"].filter(
    (extension) =>
      existsSync(path.join(canonicalDirectory, `build.config.${extension}`)),
  );
  if (configs.length > 1)
    throw new Error("Nuxt supports exactly one build configuration");
  const tool = realpathSync(require.resolve("@nuxt/module-builder"));
  const toolRequire = createRequire(tool);
  const unbuild = realpathSync(toolRequire.resolve("unbuild"));
  const unbuildRequire = createRequire(unbuild);
  for (const [name, version] of Object.entries(supportedVersions)) {
    let entry: string;
    switch (name) {
      case "@nuxt/module-builder":
        entry = tool;
        break;
      case "unbuild":
        entry = unbuild;
        break;
      case "mkdist":
        entry = realpathSync(unbuildRequire.resolve("mkdist"));
        break;
      default:
        throw new Error(`Unsupported Nuxt build tool ${name}`);
    }
    const metadata: unknown = JSON.parse(
      readFileSync(
        path.resolve(path.dirname(entry), "../package.json"),
        "utf8",
      ),
    );
    if (!record(metadata) || metadata["version"] !== version)
      throw new Error(
        `Publish target resolver supports ${name} ${version}; review the adapter before changing build tools`,
      );
  }
  let helper: string | undefined;
  if (configs.length > 0) {
    const helperEntry = realpathSync(
      require.resolve("@stll/oxlint-config/build-target"),
    );
    const metadata: unknown = JSON.parse(
      readFileSync(
        path.resolve(path.dirname(helperEntry), "../package.json"),
        "utf8",
      ),
    );
    const ownMetadata: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    if (
      !record(metadata) ||
      !record(ownMetadata) ||
      metadata["version"] !== ownMetadata["version"]
    )
      throw new Error(
        "Nuxt target helper must use the same tooling version as the resolver",
      );
    helper = pathToFileURL(helperEntry).href;
  }
  const shim = `data:text/javascript,${encodeURIComponent(captureShim(pathToFileURL(unbuild).href))}`;
  const loader = `
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const resolve=(specifier,context,next)=>{
  if(specifier!=='unbuild')return next(specifier,context);
  if(!context.parentURL||!context.parentURL.startsWith('file:')||path.dirname(realpathSync(fileURLToPath(context.parentURL)))!==${JSON.stringify(path.dirname(tool))})throw new Error('Unexpected Nuxt unbuild import parent');
  return {url:${JSON.stringify(shim)},shortCircuit:true};
};`;
  const output = execFileSync(
    process.versions.bun ? "node" : process.execPath,
    [
      "--input-type=module",
      "-e",
      captureProgram,
      JSON.stringify({
        directory: canonicalDirectory,
        tool: pathToFileURL(tool).href,
        unbuild: pathToFileURL(unbuild).href,
        jiti: pathToFileURL(realpathSync(unbuildRequire.resolve("jiti"))).href,
        helper,
        loader: `data:text/javascript,${encodeURIComponent(loader)}`,
      }),
    ],
    {
      cwd: canonicalDirectory,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, JITI_FS_CACHE: "0", JITI_MODULE_CACHE: "1" },
    },
  );
  const captures = output
    .split("\n")
    .filter((line) => line.startsWith("__STLL_NUXT_TARGET__"));
  const capture = captures.at(0);
  if (captures.length !== 1 || capture === undefined)
    throw new Error(
      "Nuxt did not return exactly one resolved build configuration",
    );
  return resolvedNuxtTarget(
    JSON.parse(capture.slice("__STLL_NUXT_TARGET__".length)),
  );
};
