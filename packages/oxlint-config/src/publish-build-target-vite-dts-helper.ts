import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

import {
  guardDeclarationHook,
  reviewedViteDtsOptions,
  reviewedViteDtsVersions,
  type ReviewedViteDtsOptions,
} from "./publish-build-target-vite-dts";

type DeclarationOnlyDtsOptions = { directory: string } & ReviewedViteDtsOptions;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The actual build uses this closed factory and its guarded declaration hooks. */
export const declarationOnlyDts = ({
  directory,
  ...options
}: DeclarationOnlyDtsOptions): Plugin => {
  const root = realpathSync(directory);
  const require = createRequire(path.join(root, "package.json"));
  const pluginRequire = createRequire(require.resolve("vite-plugin-dts"));
  for (const [name, version] of Object.entries(reviewedViteDtsVersions)) {
    const owner = name === "unplugin-dts" ? pluginRequire : require;
    const metadata: unknown = JSON.parse(
      readFileSync(owner.resolve(`${name}/package.json`), "utf8"),
    );
    if (!record(metadata) || metadata["version"] !== version)
      throw new Error(`Declaration-only adapter requires ${name} ${version}`);
  }
  const compilerRequire = createRequire(pluginRequire.resolve("unplugin-dts"));
  const compilerVersion = (name: string) => {
    try {
      const metadata: unknown = JSON.parse(
        readFileSync(compilerRequire.resolve(`${name}/package.json`), "utf8"),
      );
      return record(metadata) && typeof metadata["version"] === "string"
        ? metadata["version"]
        : undefined;
    } catch (error) {
      if (!record(error) || error["code"] !== "MODULE_NOT_FOUND") throw error;
      return undefined;
    }
  };
  const primaryCompiler = compilerVersion("typescript");
  const compatibleCompiler =
    primaryCompiler === "6.0.3" ||
    (primaryCompiler?.startsWith("7.") === true &&
      compilerVersion("@typescript/typescript6") === "6.0.3");
  if (!compatibleCompiler)
    throw new Error(
      "Declaration-only adapter requires TypeScript 6.0.3 as typescript or the TypeScript 7 @typescript/typescript6 fallback in the declaration plugin's dependency scope",
    );
  const loaded: unknown = require("vite-plugin-dts");
  const factory = record(loaded) ? loaded["default"] : loaded;
  if (typeof factory !== "function")
    throw new Error("Installed declaration plugin does not expose its factory");
  const plugin: unknown = Reflect.apply(factory, undefined, [
    reviewedViteDtsOptions(options),
  ]);
  if (!record(plugin)) throw new Error("Invalid installed declaration plugin");
  const hookNames = [
    "config",
    "configResolved",
    "buildStart",
    "transform",
    "watchChange",
    "generateBundle",
    "writeBundle",
  ] as const;
  const allowed = new Set<string>([
    "name",
    "apply",
    "enforce",
    "vite",
    "rollup",
    "rolldown",
    "webpack",
    "rspack",
    "esbuild",
    ...hookNames,
  ]);
  for (const key of Reflect.ownKeys(plugin)) {
    const descriptor = Object.getOwnPropertyDescriptor(plugin, key);
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !descriptor ||
      !("value" in descriptor)
    )
      throw new Error("Unreviewed installed declaration plugin shape");
  }
  if (
    plugin["name"] !== "unplugin-dts" ||
    plugin["apply"] !== "build" ||
    plugin["enforce"] !== "pre"
  )
    throw new Error("Unreviewed installed declaration plugin identity");
  const outputDirectories: string[] = [];
  const hook = (name: (typeof hookNames)[number]) =>
    guardDeclarationHook({
      hook: plugin[name],
      hookName: name,
      outputDirectories,
    });
  const configResolved = hook("configResolved");
  return {
    name: "stll:declaration-only-dts",
    apply: "build",
    enforce: "pre",
    config: hook("config"),
    async configResolved(config) {
      if (
        realpathSync(config.root) !== root ||
        config.build.write === false ||
        config.build.watch
      )
        throw new Error(
          "Declaration-only adapter requires a package-local production build",
        );
      const output = path.resolve(root, config.build.outDir);
      const relative = path.relative(root, output);
      if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error(
          "Declaration output directory must stay within the package",
        );
      // Check existing ancestor paths before the declaration plugin can write.
      let ancestor = output;
      while (ancestor !== root) {
        try {
          const resolved = realpathSync(ancestor);
          const within = path.relative(root, resolved);
          if (
            within === ".." ||
            within.startsWith(`..${path.sep}`) ||
            path.isAbsolute(within)
          )
            throw new Error("Declaration output directory leaves the package");
          break;
        } catch (error) {
          if (!record(error) || error["code"] !== "ENOENT") throw error;
          ancestor = path.dirname(ancestor);
        }
      }
      outputDirectories.push(output);
      await configResolved.call(this, config);
    },
    buildStart: hook("buildStart"),
    transform: hook("transform"),
    watchChange: hook("watchChange"),
    generateBundle: hook("generateBundle"),
    writeBundle: hook("writeBundle"),
  };
};
