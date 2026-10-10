import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { PublishTarget } from "./publish-contract";

const supportedViteVersion = "8.1.5";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ownEntries = (value: object): [string, unknown][] =>
  Reflect.ownKeys(value).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !("value" in descriptor))
      throw new Error("Unsupported Vite hook property");
    return [key, descriptor.value];
  });
const metadataSource = (value: unknown): string => {
  if (value instanceof RegExp)
    return JSON.stringify(["regexp", value.source, value.flags]);
  if (Array.isArray(value))
    return JSON.stringify(["array", value.map(metadataSource)]);
  if (record(value)) {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error("Unsupported Vite hook metadata");
    return JSON.stringify([
      "object",
      ownEntries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, metadataSource(item)]),
    ]);
  }
  if (value === undefined) return "undefined";
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return JSON.stringify(value);
  throw new Error("Unsupported Vite hook metadata");
};
const hookSource = (value: unknown) => {
  if (typeof value === "function")
    return JSON.stringify([
      "function",
      Function.prototype.toString.call(value),
    ]);
  if (!record(value)) throw new Error("Unsupported Vite build hook");
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Unsupported Vite hook metadata");
  const entries = ownEntries(value);
  const handler = entries.find(([key]) => key === "handler")?.[1];
  if (typeof handler !== "function")
    throw new Error("Unsupported Vite build hook");
  const metadata = entries.filter(([key]) => key !== "handler");
  if (
    metadata.some(([key]) => !["order", "sequential", "filter"].includes(key))
  )
    throw new Error("Unsupported Vite hook metadata");
  return JSON.stringify([
    "object",
    Function.prototype.toString.call(handler),
    metadataSource(Object.fromEntries(metadata)),
  ]);
};
const pluginEntries = (plugin: object) => {
  const entries = new Map<string, unknown>();
  let current = plugin;
  while (current !== Object.prototype) {
    for (const [key, value] of ownEntries(current)) {
      if (current !== plugin && key === "constructor") continue;
      if (!entries.has(key)) entries.set(key, value);
    }
    const prototype: unknown = Object.getPrototypeOf(current);
    if (prototype === null) break;
    if (!record(prototype))
      throw new Error("Unsupported Vite plugin prototype");
    current = prototype;
  }
  return entries;
};
const plugins = (config: unknown): unknown[] => {
  if (
    !record(config) ||
    !record(config["build"]) ||
    !record(config["environments"])
  )
    throw new Error("Invalid Vite plugin configuration");
  const environment =
    config["environments"][
      config["build"]["ssr"] === true ||
      (typeof config["build"]["ssr"] === "string" &&
        config["build"]["ssr"] !== "")
        ? "ssr"
        : "client"
    ];
  if (
    !record(environment) ||
    !Array.isArray(environment["plugins"]) ||
    !Array.isArray(config["plugins"])
  )
    throw new Error("Missing resolved Vite environment plugins");
  const options = config["build"]["rolldownOptions"];
  const extra = record(options) ? options["plugins"] : undefined;
  if (extra !== undefined && !Array.isArray(extra))
    throw new Error(
      "Dynamic Vite rolldown plugins require a supported target resolver",
    );
  return [
    ...config["plugins"],
    ...environment["plugins"],
    ...(extra ?? []),
  ].flat(Infinity);
};

type ReviewedVitePluginsOptions = {
  resolved: readonly unknown[];
  reviewed: readonly unknown[];
};
type ReviewedVueOptions = { plugin: unknown; reviewed: unknown };
/** Vue hook closures may only capture the reviewed factory's default options. */
export const assertReviewedVueOptions = ({
  plugin,
  reviewed,
}: ReviewedVueOptions) => {
  const fail = () => {
    throw new Error(
      "Custom Vue plugin options require a supported target resolver",
    );
  };
  if (
    !record(plugin) ||
    !record(reviewed) ||
    !record(plugin["api"]) ||
    !record(reviewed["api"])
  )
    return fail();
  const api = plugin["api"];
  const defaults = reviewed["api"];
  const options = api["options"];
  const defaultOptions = defaults["options"];
  if (!record(options) || !record(defaultOptions)) return fail();
  if (
    Object.getPrototypeOf(options) !== Object.prototype &&
    Object.getPrototypeOf(options) !== null
  )
    return fail();
  if (
    metadataSource(api["include"]) !== metadataSource(defaults["include"]) ||
    api["exclude"] !== undefined
  )
    return fail();
  const lifecycleFields = new Set([
    "isProduction",
    "sourceMap",
    "cssDevSourcemap",
    "devToolsEnabled",
  ]);
  for (const [key, value] of ownEntries(options)) {
    if (key === "root") {
      if (typeof value !== "string") return fail();
      continue;
    }
    if (lifecycleFields.has(key)) {
      if (typeof value !== "boolean") return fail();
      continue;
    }
    if (key === "compiler") {
      if (value !== null && value !== undefined) return fail();
      continue;
    }
    if (
      !Object.hasOwn(defaultOptions, key) ||
      metadataSource(value) !== metadataSource(defaultOptions[key])
    )
      return fail();
  }
  for (const [key] of ownEntries(defaultOptions)) {
    if (!Object.hasOwn(options, key) && key !== "compiler") return fail();
  }
};
const vitePluginMetadata = new Set([
  "enforce",
  "_options",
  "perEnvironmentStartEndDuringDev",
]);
const pluginSources = (plugin: object) => {
  const entries = pluginEntries(plugin);
  for (const key of [...vitePluginMetadata, "apply"])
    if (!entries.has(key)) entries.set(key, undefined);
  const sources = new Map<string, string>();
  for (const [key, value] of entries) {
    if (key === "name" || key === "api") continue;
    if (
      vitePluginMetadata.has(key) ||
      (key === "apply" && typeof value !== "function")
    )
      sources.set(key, `metadata:${metadataSource(value)}`);
    else sources.set(key, `hook:${hookSource(value)}`);
  }
  return sources;
};

/** Reviewed tool versions own the plugin name, hook name and implementation together. */
export const assertReviewedVitePlugins = ({
  resolved,
  reviewed,
}: ReviewedVitePluginsOptions) => {
  const identities = new Map<string, Map<string, Set<string>>>();
  for (const plugin of reviewed) {
    if (!record(plugin) || typeof plugin["name"] !== "string")
      throw new Error("Invalid reviewed Vite plugin");
    const name = plugin["name"];
    const hooks = identities.get(name) ?? new Map<string, Set<string>>();
    identities.set(name, hooks);
    for (const [key, source] of pluginSources(plugin)) {
      const sources = hooks.get(key) ?? new Set<string>();
      sources.add(source);
      hooks.set(key, sources);
    }
  }
  for (const plugin of resolved) {
    if (plugin === undefined || plugin === null || plugin === false) continue;
    if (!record(plugin) || typeof plugin["name"] !== "string")
      throw new Error(
        "Dynamic Vite plugins require a supported target resolver",
      );
    const name = plugin["name"];
    const hooks = identities.get(name);
    if (hooks === undefined)
      throw new Error(
        `Unreviewed Vite plugin ${name} requires a supported target resolver`,
      );
    for (const [key, source] of pluginSources(plugin)) {
      if (!hooks.get(key)?.has(source))
        throw new Error(
          `Unreviewed Vite hook ${name}:${key} requires a supported target resolver`,
        );
    }
  }
};

/** Vite 8 spreads transform overrides after its resolved build target. */
export const resolvedViteTarget = (config: unknown): PublishTarget => {
  if (!record(config) || !record(config["build"]))
    throw new Error("Invalid resolved Vite build configuration");
  if (config["builder"] !== undefined)
    throw new Error("Custom Vite builders require a supported target resolver");
  const build = config["build"];
  const options = build["rolldownOptions"];
  if (options !== undefined && !record(options))
    throw new Error("Vite rolldownOptions must be an object");
  const output = record(options) ? options["output"] : undefined;
  if (output !== undefined) {
    const outputs = Array.isArray(output) ? output : [output];
    for (const entry of outputs) {
      if (!record(entry)) throw new Error("Unsupported Vite output options");
      for (const key of ["banner", "footer", "intro", "outro"]) {
        if (entry[key] !== undefined && entry[key] !== "")
          throw new Error(
            "Vite output addons require a supported target resolver",
          );
      }
      const outputPlugins = entry["plugins"];
      if (
        outputPlugins !== undefined &&
        (!Array.isArray(outputPlugins) || outputPlugins.length > 0)
      )
        throw new Error(
          "Vite output plugins require a supported target resolver",
        );
    }
  }
  const transform = record(options) ? options["transform"] : undefined;
  if (transform !== undefined && !record(transform))
    throw new Error("Vite transform overrides must be an object");
  let target = build["target"] === false ? undefined : build["target"];
  if (record(transform) && "target" in transform) target = transform["target"];
  if (target === undefined) return { type: "javascript", targets: ["esnext"] };
  const targets = typeof target === "string" ? [target] : target;
  if (!Array.isArray(targets) || targets.length === 0)
    throw new Error("Unsupported resolved Vite JavaScript target");
  const emitted = new Set<string>();
  for (const item of targets) {
    if (typeof item !== "string" || item.length === 0)
      throw new Error("Unsupported resolved Vite JavaScript target");
    emitted.add(item);
  }
  return { type: "javascript", targets: [...emitted].sort() };
};

export const resolveVitePublishTarget = async (
  directory: string,
): Promise<PublishTarget> => {
  const canonicalDirectory = realpathSync(directory);
  const require = createRequire(path.join(canonicalDirectory, "package.json"));
  const metadata: unknown = JSON.parse(
    readFileSync(require.resolve("vite/package.json"), "utf8"),
  );
  if (!record(metadata) || metadata["version"] !== supportedViteVersion)
    throw new Error(
      `Publish target resolver supports Vite ${supportedViteVersion}; review the adapter before changing build tools`,
    );
  const tool: unknown = await import(
    pathToFileURL(realpathSync(require.resolve("vite"))).href
  );
  if (!record(tool) || typeof tool["resolveConfig"] !== "function")
    throw new Error(
      "Installed Vite does not expose its configuration resolver",
    );
  // Match the legacy CLI builder's patch before configResolved hooks run.
  const patchConfig = (resolved: unknown) => {
    if (
      !record(resolved) ||
      !record(resolved["build"]) ||
      !record(resolved["environments"])
    )
      throw new Error("Invalid Vite environment configuration");
    if (resolved["builder"] !== undefined)
      throw new Error(
        "Custom Vite builders require a supported target resolver",
      );
    const environment =
      resolved["environments"][
        resolved["build"]["ssr"] === true ||
        (typeof resolved["build"]["ssr"] === "string" &&
          resolved["build"]["ssr"] !== "")
          ? "ssr"
          : "client"
      ];
    if (!record(environment) || !record(environment["build"]))
      throw new Error("Missing resolved Vite build environment");
    resolved["build"] = { ...environment["build"] };
  };
  const config: unknown = await tool["resolveConfig"](
    { root: canonicalDirectory },
    "build",
    "production",
    "production",
    false,
    patchConfig,
  );
  const canonical: unknown = await tool["resolveConfig"](
    { root: canonicalDirectory, configFile: false },
    "build",
    "production",
    "production",
    false,
    patchConfig,
  );
  if (
    !record(config) ||
    !record(config["build"]) ||
    !record(canonical) ||
    !record(canonical["build"]) ||
    hookSource(config["build"]["createEnvironment"]) !==
      hookSource(canonical["build"]["createEnvironment"])
  )
    throw new Error(
      "Custom Vite createEnvironment requires a supported target resolver",
    );
  const reviewedPlugins = plugins(canonical);
  const resolvedPlugins = plugins(config);
  if (
    resolvedPlugins.some(
      (plugin) => record(plugin) && plugin["name"] === "vite:vue",
    )
  ) {
    const vueMetadata: unknown = JSON.parse(
      readFileSync(require.resolve("@vitejs/plugin-vue/package.json"), "utf8"),
    );
    if (!record(vueMetadata) || vueMetadata["version"] !== "6.0.8")
      throw new Error(
        "Publish target resolver supports @vitejs/plugin-vue 6.0.8; review the adapter before changing build tools",
      );
    const vue: unknown = await import(
      pathToFileURL(realpathSync(require.resolve("@vitejs/plugin-vue"))).href
    );
    if (!record(vue) || typeof vue["default"] !== "function")
      throw new Error("Invalid installed Vue plugin factory");
    const plugin: unknown = vue["default"]();
    if (!record(plugin)) throw new Error("Invalid installed Vue plugin");
    for (const resolved of resolvedPlugins) {
      if (record(resolved) && resolved["name"] === "vite:vue")
        assertReviewedVueOptions({ plugin: resolved, reviewed: plugin });
    }
    reviewedPlugins.push(plugin);
  }
  assertReviewedVitePlugins({
    resolved: resolvedPlugins,
    reviewed: reviewedPlugins,
  });
  return resolvedViteTarget(config);
};
