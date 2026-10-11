import { parse } from "acorn";
import { transformSync } from "esbuild";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { reviewedViteDtsOptions } from "./publish-build-target-vite-dts";
import { declarationOnlyDts } from "./publish-build-target-vite-dts-helper";
import type { PublishTarget } from "./publish-contract";

const supportedViteVersion = "8.1.5";
const declarationHelperImport = "@stll/oxlint-config/declaration-only-dts";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type WalkAstOptions = {
  value: unknown;
  visit: (
    node: Record<string, unknown>,
    parent: Record<string, unknown> | undefined,
  ) => void;
  parent?: Record<string, unknown>;
};
const walkAst = ({ value, visit, parent }: WalkAstOptions) => {
  if (Array.isArray(value)) {
    for (const entry of value)
      walkAst({
        value: entry,
        visit,
        ...(parent === undefined ? {} : { parent }),
      });
    return;
  }
  if (!record(value)) return;
  visit(value, parent);
  for (const entry of Object.values(value))
    if (typeof entry === "object" && entry !== null)
      walkAst({ value: entry, visit, parent: value });
};
const astName = (value: unknown) =>
  record(value) && value["type"] === "Identifier" ? value["name"] : undefined;
const astLiteral = (value: unknown): unknown => {
  if (!record(value))
    throw new Error("Declaration helper options must be literal");
  if (
    value["type"] === "Literal" &&
    (typeof value["value"] === "string" || typeof value["value"] === "boolean")
  )
    return value["value"];
  if (value["type"] === "ArrayExpression" && Array.isArray(value["elements"]))
    return value["elements"].map(astLiteral);
  if (
    value["type"] === "ObjectExpression" &&
    Array.isArray(value["properties"])
  ) {
    const entries: [string, unknown][] = [];
    for (const property of value["properties"]) {
      if (
        !record(property) ||
        property["type"] !== "Property" ||
        property["kind"] !== "init" ||
        property["computed"] === true ||
        property["method"] === true ||
        property["shorthand"] === true
      )
        throw new Error(
          "Declaration helper options must be plain literal properties",
        );
      const key =
        astName(property["key"]) ??
        (record(property["key"]) ? property["key"]["value"] : undefined);
      if (
        typeof key !== "string" ||
        entries.some(([previous]) => previous === key)
      )
        throw new Error("Invalid declaration helper option key");
      entries.push([key, astLiteral(property["value"])]);
    }
    return Object.fromEntries(entries);
  }
  throw new Error("Declaration helper options must be literal");
};
type ReviewedDtsConfigurationOptions = {
  source: string;
  directory: string;
  loader: "ts" | "js";
};
/** Prove the helper owns the directly declared plugin; closure brands alone are insufficient. */
export const reviewedDtsConfiguration = ({
  source,
  directory,
  loader,
}: ReviewedDtsConfigurationOptions) => {
  const ast: unknown = parse(
    transformSync(source, { loader, format: "esm", target: "esnext" }).code,
    { ecmaVersion: "latest", sourceType: "module" },
  );
  if (!record(ast) || !Array.isArray(ast["body"]))
    throw new Error("Invalid Vite configuration AST");
  const bindings = new Set<string>();
  const defineConfigBindings = new Set<string>();
  const initializers = new Map<unknown, unknown>();
  let exported: unknown;
  for (const statement of ast["body"]) {
    if (!record(statement)) continue;
    if (
      statement["type"] === "ImportDeclaration" &&
      record(statement["source"])
    ) {
      const imported = statement["source"]["value"];
      if (
        typeof imported === "string" &&
        /^(?:vite-plugin-dts|unplugin-dts)(?:\/|$)/.test(imported)
      )
        throw new Error(
          "Raw declaration emitters cannot accompany the reviewed helper",
        );
      if (Array.isArray(statement["specifiers"]))
        for (const specifier of statement["specifiers"]) {
          if (!record(specifier)) continue;
          const local = astName(specifier["local"]);
          const name = astName(specifier["imported"]);
          if (imported === declarationHelperImport) {
            if (
              specifier["type"] !== "ImportSpecifier" ||
              name !== "declarationOnlyDts" ||
              typeof local !== "string"
            )
              throw new Error("Use the named declarationOnlyDts helper import");
            bindings.add(local);
          }
          if (
            imported === "vite" &&
            name === "defineConfig" &&
            typeof local === "string"
          )
            defineConfigBindings.add(local);
        }
    }
    if (
      statement["type"] === "VariableDeclaration" &&
      Array.isArray(statement["declarations"])
    )
      for (const declaration of statement["declarations"])
        if (record(declaration))
          initializers.set(astName(declaration["id"]), declaration["init"]);
    if (statement["type"] === "ExportDefaultDeclaration")
      exported = statement["declaration"];
    if (
      statement["type"] === "ExportNamedDeclaration" &&
      Array.isArray(statement["specifiers"])
    )
      for (const specifier of statement["specifiers"])
        if (record(specifier) && astName(specifier["exported"]) === "default")
          exported = specifier["local"];
  }
  if (bindings.size !== 1)
    throw new Error(
      "Vite declaration plugins require one statically imported helper",
    );
  if (record(exported) && exported["type"] === "Identifier")
    exported = initializers.get(astName(exported));
  if (
    record(exported) &&
    exported["type"] === "CallExpression" &&
    defineConfigBindings.has(String(astName(exported["callee"]))) &&
    Array.isArray(exported["arguments"]) &&
    exported["arguments"].length === 1
  )
    exported = exported["arguments"].at(0);
  if (
    !record(exported) ||
    exported["type"] !== "ObjectExpression" ||
    !Array.isArray(exported["properties"])
  )
    throw new Error(
      "Declaration helper requires a directly exported static Vite configuration",
    );
  const pluginProperties = exported["properties"].filter(
    (property) =>
      record(property) &&
      (astName(property["key"]) === "plugins" ||
        (record(property["key"]) && property["key"]["value"] === "plugins")),
  );
  const property = pluginProperties.at(0);
  if (
    pluginProperties.length !== 1 ||
    !record(property) ||
    property["computed"] === true ||
    property["kind"] !== "init" ||
    !record(property["value"]) ||
    property["value"]["type"] !== "ArrayExpression" ||
    !Array.isArray(property["value"]["elements"])
  )
    throw new Error("Declaration helper requires a literal plugins array");
  const calls = property["value"]["elements"]
    .map((element) =>
      record(element) && element["type"] === "AwaitExpression"
        ? element["argument"]
        : element,
    )
    .filter(
      (element) =>
        record(element) &&
        element["type"] === "CallExpression" &&
        bindings.has(String(astName(element["callee"]))),
    );
  const call = calls.at(0);
  if (
    calls.length !== 1 ||
    !record(call) ||
    !Array.isArray(call["arguments"]) ||
    call["arguments"].length !== 1
  )
    throw new Error("Declare exactly one direct declaration helper call");
  walkAst({
    value: ast,
    visit: (node, parent) => {
      if (node["type"] === "ImportDeclaration") return;
      const name = astName(node);
      if (typeof name !== "string" || !bindings.has(name)) return;
      if (parent?.["type"] === "ImportSpecifier") return;
      if (parent !== call || call["callee"] !== node)
        throw new Error(
          "Declaration helper binding cannot be aliased or invoked indirectly",
        );
    },
  });
  const argument = call["arguments"].at(0);
  if (
    !record(argument) ||
    argument["type"] !== "ObjectExpression" ||
    !Array.isArray(argument["properties"])
  )
    throw new Error("Declaration helper options must be a literal object");
  const directoryProperties = argument["properties"].filter(
    (entry) => record(entry) && astName(entry["key"]) === "directory",
  );
  const directoryProperty = directoryProperties.at(0);
  if (
    directoryProperties.length !== 1 ||
    !record(directoryProperty) ||
    directoryProperty["computed"] === true ||
    directoryProperty["kind"] !== "init"
  )
    throw new Error("Declaration helper requires its package directory");
  const value = directoryProperty["value"];
  const meta = record(value) ? value["object"] : undefined;
  const importDirectory =
    record(value) &&
    value["type"] === "MemberExpression" &&
    value["computed"] === false &&
    astName(value["property"]) === "dirname" &&
    record(meta) &&
    meta["type"] === "MetaProperty" &&
    astName(meta["meta"]) === "import" &&
    astName(meta["property"]) === "meta";
  const exactDirectory =
    record(value) &&
    value["type"] === "Literal" &&
    value["value"] === directory;
  if (!importDirectory && !exactDirectory)
    throw new Error(
      "Declaration helper directory must be import.meta.dirname or the exact package directory",
    );
  return reviewedViteDtsOptions(
    astLiteral({
      ...argument,
      properties: argument["properties"].filter(
        (entry) => entry !== directoryProperty,
      ),
    }),
  );
};

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
  const fail = () =>
    new Error("Custom Vue plugin options require a supported target resolver");
  if (
    !record(plugin) ||
    !record(reviewed) ||
    !record(plugin["api"]) ||
    !record(reviewed["api"])
  )
    throw fail();
  const api = plugin["api"];
  const defaults = reviewed["api"];
  const options = api["options"];
  const defaultOptions = defaults["options"];
  if (!record(options) || !record(defaultOptions)) throw fail();
  if (
    Object.getPrototypeOf(options) !== Object.prototype &&
    Object.getPrototypeOf(options) !== null
  )
    throw fail();
  if (
    metadataSource(api["include"]) !== metadataSource(defaults["include"]) ||
    api["exclude"] !== undefined
  )
    throw fail();
  const lifecycleFields = new Set([
    "isProduction",
    "sourceMap",
    "cssDevSourcemap",
    "devToolsEnabled",
  ]);
  for (const [key, value] of ownEntries(options)) {
    if (key === "root") {
      if (typeof value !== "string") throw fail();
      continue;
    }
    if (lifecycleFields.has(key)) {
      if (typeof value !== "boolean") throw fail();
      continue;
    }
    if (key === "compiler") {
      if (value !== null && value !== undefined) throw fail();
      continue;
    }
    if (
      !Object.hasOwn(defaultOptions, key) ||
      metadataSource(value) !== metadataSource(defaultOptions[key])
    )
      throw fail();
  }
  for (const [key] of ownEntries(defaultOptions)) {
    if (!Object.hasOwn(options, key) && key !== "compiler") throw fail();
  }
};
const vitePluginMetadata = new Set([
  "enforce",
  "_options",
  "perEnvironmentStartEndDuringDev",
  "perEnvironmentWatchChangeDuringDev",
]);
const nativeCallbackFields = new Map([
  ["builtin:vite-resolve", "resolveSubpathImports"],
  ["builtin:vite-dynamic-import-vars", "resolver"],
  ["builtin:vite-reporter", "logInfo"],
]);
const nativeOptionsSource = (name: string, value: unknown) => {
  if (!record(value)) return metadataSource(value);
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Unsupported Vite native options");
  return JSON.stringify(
    ownEntries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => {
        if (
          key === nativeCallbackFields.get(name) &&
          typeof item === "function"
        )
          return [
            key,
            "reviewed-callback",
            Function.prototype.toString.call(item),
          ];
        return [key, "metadata", metadataSource(item)];
      }),
  );
};
const pluginSources = (plugin: object) => {
  const entries = pluginEntries(plugin);
  for (const key of [...vitePluginMetadata, "apply"])
    if (!entries.has(key)) entries.set(key, undefined);
  const sources = new Map<string, string>();
  for (const [key, value] of entries) {
    if (key === "name" || key === "api") continue;
    if (key === "_options") {
      const name = entries.get("name");
      if (typeof name !== "string") throw new Error("Invalid Vite plugin name");
      sources.set(key, `native:${nativeOptionsSource(name, value)}`);
      continue;
    }
    if (
      vitePluginMetadata.has(key) ||
      (key === "apply" && typeof value !== "function")
    )
      sources.set(key, `metadata:${metadataSource(value)}`);
    else if (value === undefined) sources.set(key, "absent-hook");
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
  const pipelineIdentity = (plugin: unknown) => {
    if (!record(plugin) || typeof plugin["name"] !== "string")
      throw new Error("Invalid reviewed Vite pipeline entry");
    return JSON.stringify([
      plugin["name"],
      [...pluginSources(plugin)].sort(([a], [b]) => a.localeCompare(b)),
    ]);
  };
  const actualPipeline = resolved.filter(
    (plugin) => plugin !== undefined && plugin !== null && plugin !== false,
  );
  if (
    actualPipeline.length !== reviewed.length ||
    reviewed.some(
      (plugin, index) =>
        pipelineIdentity(plugin) !== pipelineIdentity(actualPipeline[index]),
    )
  )
    throw new Error(
      "Vite plugin pipeline must match the complete reviewed order",
    );
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

/** Only static build settings needed by the installed tool's canonical profile cross this boundary. */
export const reviewedViteBuild = (build: unknown) => {
  if (!record(build)) throw new Error("Invalid Vite build configuration");
  const properties = new Map(ownEntries(build));
  const result: Record<string, unknown> = {};
  for (const key of [
    "target",
    "sourcemap",
    "minify",
    "ssr",
    "cssCodeSplit",
    "assetsInlineLimit",
    "assetsDir",
    "reportCompressedSize",
    "chunkSizeWarningLimit",
    "modulePreload",
  ]) {
    const value = properties.get(key);
    metadataSource(value);
    result[key] = value;
  }
  const library = properties.get("lib");
  if (record(library)) {
    if (
      Object.getPrototypeOf(library) !== Object.prototype &&
      Object.getPrototypeOf(library) !== null
    )
      throw new Error("Unsupported Vite library configuration");
    const libraryProperties = new Map(ownEntries(library));
    const fields: Record<string, unknown> = {};
    for (const key of ["entry", "formats", "name"]) {
      const value = libraryProperties.get(key);
      metadataSource(value);
      fields[key] = value;
    }
    result["lib"] = fields;
  } else if (library === undefined || library === false)
    result["lib"] = library;
  else throw new Error("Unsupported Vite library configuration");
  return result;
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
  if (!record(config) || !record(config["build"]))
    throw new Error("Invalid Vite build configuration");
  const resolvedPlugins = plugins(config);
  const canonicalVuePlugins: unknown[] = [];
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
    canonicalVuePlugins.push(plugin);
  }
  if (
    resolvedPlugins.some(
      (plugin) =>
        record(plugin) && plugin["name"] === "stll:declaration-only-dts",
    )
  ) {
    const configFile = config["configFile"];
    if (
      typeof configFile !== "string" ||
      path.dirname(realpathSync(configFile)) !== canonicalDirectory
    )
      throw new Error(
        "Declaration helper requires a package-local Vite config file",
      );
    const options = reviewedDtsConfiguration({
      source: readFileSync(configFile, "utf8"),
      directory: canonicalDirectory,
      loader: /\.[cm]?ts$/.test(configFile) ? "ts" : "js",
    });
    canonicalVuePlugins.push(
      declarationOnlyDts({ directory: canonicalDirectory, ...options }),
    );
  }
  const canonicalBuild = reviewedViteBuild(config["build"]);
  const canonical: unknown = await tool["resolveConfig"](
    {
      root: canonicalDirectory,
      configFile: false,
      plugins: canonicalVuePlugins,
      build: canonicalBuild,
    },
    "build",
    "production",
    "production",
    false,
    patchConfig,
  );
  if (
    !record(canonical) ||
    !record(canonical["build"]) ||
    hookSource(config["build"]["createEnvironment"]) !==
      hookSource(canonical["build"]["createEnvironment"])
  )
    throw new Error(
      "Custom Vite createEnvironment requires a supported target resolver",
    );
  const reviewedPlugins = plugins(canonical);
  assertReviewedVitePlugins({
    resolved: resolvedPlugins,
    reviewed: reviewedPlugins,
  });
  return resolvedViteTarget(config);
};
