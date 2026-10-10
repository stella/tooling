import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { PublishTarget } from "./publish-contract";

const supportedViteVersion = "8.1.5";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hookFunction = (value: unknown) =>
  record(value) ? value["handler"] : value;
const hookSource = (value: unknown) => {
  const hook = hookFunction(value);
  if (typeof hook !== "function")
    throw new Error("Unsupported Vite build hook");
  return Function.prototype.toString.call(hook);
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
  const allowedOptions = new Set(
    plugins(canonical).flatMap((plugin) =>
      record(plugin) && plugin["options"] !== undefined
        ? [hookSource(plugin["options"])]
        : [],
    ),
  );
  const resolvedPlugins = plugins(config);
  if (
    resolvedPlugins.some(
      (plugin) =>
        record(plugin) &&
        plugin["name"] === "vite:vue" &&
        plugin["options"] !== undefined,
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
    allowedOptions.add(hookSource(plugin["options"]));
  }
  for (const plugin of resolvedPlugins) {
    if (plugin === undefined || plugin === null || plugin === false) continue;
    if (!record(plugin))
      throw new Error(
        "Dynamic Vite plugins require a supported target resolver",
      );
    if (plugin["buildApp"] !== undefined)
      throw new Error(
        "Vite buildApp hooks require a supported target resolver",
      );
    if (
      plugin["options"] !== undefined &&
      !allowedOptions.has(hookSource(plugin["options"]))
    )
      throw new Error(
        "Custom Vite options hooks require a supported target resolver",
      );
  }
  return resolvedViteTarget(config);
};
