import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveNuxtPublishTarget } from "./publish-build-target-nuxt";
import { resolveVitePublishTarget } from "./publish-build-target-vite";
import {
  resolveManifestContract,
  type PublishTarget,
} from "./publish-contract";

const supportedTsdownVersion = "0.22.9";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const targets = (value: unknown): string[] => {
  if (value === undefined) return ["esnext"];
  if (typeof value === "string") {
    const identifier = value.trim();
    if (identifier === "" || identifier.includes(","))
      throw new Error(
        "Resolved JavaScript target identifiers must be nonempty and contain no commas",
      );
    return [identifier];
  }
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    Array.from(value).every((item: unknown) => typeof item === "string")
  )
    return value.flatMap((item: string) => targets(item));
  throw new Error(
    "Build tool returned an unsupported resolved JavaScript target",
  );
};

/** Only hooks completed by configuration resolution may run before target capture. */
export const assertTsdownBuildExtensions = (options: unknown) => {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const entries = (value: object): [string, unknown][] => {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error(
        "Unreviewed build option prototype requires a supported target resolver",
      );
    return Reflect.ownKeys(value).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor || !("value" in descriptor))
        throw new Error(
          "Unreviewed build option property requires a supported target resolver",
        );
      return [key, descriptor.value];
    });
  };
  const plugins = (value: unknown, phase: "configuration" | "output") => {
    if (value === undefined || value === null || value === false) return;
    if (Array.isArray(value)) {
      for (const plugin of value) plugins(plugin, phase);
      return;
    }
    if (!isRecord(value))
      throw new Error("Dynamic plugins require a supported target resolver");
    for (const [key, item] of entries(value)) {
      if (item === undefined) continue;
      if (key === "name" && typeof item === "string") continue;
      if (
        phase === "configuration" &&
        ["tsdownConfig", "tsdownConfigResolved"].includes(key) &&
        typeof item === "function"
      )
        continue;
      throw new Error(
        "Unreviewed plugin hooks require a supported target resolver",
      );
    }
  };
  const output = (value: unknown) => {
    if (value === undefined) return;
    if (!isRecord(value))
      throw new Error(
        "Dynamic output options require a supported target resolver",
      );
    for (const [key, item] of entries(value)) {
      if (key === "plugins") plugins(item, "output");
      if (
        ["banner", "footer", "intro", "outro"].includes(key) &&
        item !== undefined &&
        item !== ""
      )
        throw new Error("Output addons require a supported target resolver");
    }
  };
  if (!isRecord(options)) throw new Error("Invalid build configuration");
  const properties = new Map(entries(options));
  if (properties.get("hooks") !== undefined)
    throw new Error("Build hooks require a supported target resolver");
  plugins(properties.get("plugins"), "configuration");
  output(properties.get("outputOptions"));
  for (const key of ["banner", "footer"]) {
    const addon = properties.get(key);
    if (addon !== undefined && addon !== "")
      throw new Error("Output addons require a supported target resolver");
  }
  const input = properties.get("inputOptions");
  if (input !== undefined) {
    if (!isRecord(input))
      throw new Error(
        "Dynamic tsdown inputOptions require a supported target resolver",
      );
    plugins(new Map(entries(input)).get("plugins"), "output");
  }
};

/** Extract the final target after supported format and low-level overrides. */
export const resolvedTsdownTarget = (configs: unknown): PublishTarget => {
  if (!Array.isArray(configs) || configs.length === 0)
    throw new Error("tsdown must resolve at least one build configuration");
  const emitted = new Set<string>();
  let javascript = false;
  for (const config of configs) {
    if (!record(config))
      throw new Error("Invalid resolved tsdown configuration");
    assertTsdownBuildExtensions(config);
    if (record(config["dts"]) && config["dts"]["emitDtsOnly"] === true)
      continue;
    javascript = true;
    const input = config["inputOptions"];
    if (input !== undefined && !record(input))
      throw new Error(
        "Dynamic tsdown inputOptions require a supported target resolver",
      );
    const transform = record(input) ? input["transform"] : undefined;
    if (transform !== undefined && !record(transform))
      throw new Error("tsdown transform overrides must be an object");
    const target =
      record(transform) && transform["target"] != null
        ? transform["target"]
        : config["target"];
    for (const item of targets(target)) emitted.add(item);
  }
  return javascript
    ? { type: "javascript", targets: [...emitted].sort() }
    : { type: "types-only" };
};

const exportPaths = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (value === null || value === undefined) return [];
  if (Array.isArray(value))
    return value.flatMap((item: unknown) => exportPaths(item));
  if (record(value)) return Object.values(value).flatMap(exportPaths);
  throw new Error("Invalid package export declaration");
};

/** JSON and declaration-only packages have no emitted JavaScript target. */
export const assetOnlyTarget = (
  manifest: unknown,
): PublishTarget | undefined => {
  if (!record(manifest)) throw new Error("Package manifest must be an object");
  if (record(manifest["scripts"]) && manifest["scripts"]["build"] !== undefined)
    return undefined;
  const published = resolveManifestContract({
    manifest,
    target: { type: "types-only" },
  });
  const paths = (
    ["exports", "main", "module", "types", "typings", "bin"] as const
  ).flatMap((key) => exportPaths(published.entryPoints[key]));
  if (
    paths.length === 0 ||
    paths.some((item) => !/(?:\.json|\.d\.(?:ts|mts|cts))$/.test(item))
  )
    return undefined;
  return { type: "types-only" };
};

/** Supported build commands have no shell composition or runtime relocation. */
export const supportedPublishBuildCommand = (build: string) => {
  const command = build.replace(/[ \t]+/g, " ").replace(/^ | $/g, "");
  switch (command) {
    case "tsdown":
      return "tsdown";
    case "vite build":
      return "vite";
    case "nuxt-module-build build":
      return "nuxt-module-build";
  }
  throw new Error(
    "Publish target resolver requires an exact single invocation: tsdown, vite build, or nuxt-module-build build; shell composition, launchers, filters and CLI overrides are unsupported",
  );
};

export const resolvePublishBuildTarget = async (
  directory: string,
): Promise<PublishTarget> => {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(directory, "package.json"), "utf8"),
  );
  const assets = assetOnlyTarget(manifest);
  if (assets !== undefined) return assets;
  if (
    !record(manifest) ||
    !record(manifest["scripts"]) ||
    typeof manifest["scripts"]["build"] !== "string"
  )
    throw new Error(
      "A JavaScript package needs an explicitly supported build command",
    );
  const compiler = supportedPublishBuildCommand(manifest["scripts"]["build"]);
  switch (compiler) {
    case "vite":
      return await resolveVitePublishTarget(directory);
    case "nuxt-module-build":
      return resolveNuxtPublishTarget(directory);
    case "tsdown":
      break;
  }
  const configFiles = ["ts", "mts", "cts", "js", "mjs", "cjs", "json"]
    .map((extension) => path.join(directory, `tsdown.config.${extension}`))
    .filter(existsSync);
  if (configFiles.length !== 1)
    throw new Error(
      "Publish target resolver requires exactly one tsdown configuration",
    );
  const configFile = configFiles.at(0);
  if (configFile === undefined) throw new Error("Missing tsdown configuration");
  const require = createRequire(path.join(directory, "package.json"));
  const metadata: unknown = JSON.parse(
    readFileSync(require.resolve("tsdown/package.json"), "utf8"),
  );
  if (!record(metadata) || metadata["version"] !== supportedTsdownVersion)
    throw new Error(
      `Publish target resolver supports tsdown ${supportedTsdownVersion}; review the adapter before changing build tools`,
    );
  const loaderRequire = createRequire(import.meta.url);
  // Register tsx in the isolated Node process before any config imports. The
  // global registration avoids namespaced CJS imports rewriting builtin URLs.
  // The caller's Node executable owns config parsing and resolution, even when
  // the guard itself runs under Bun. Only final target data crosses the boundary.
  const scratch = mkdtempSync(path.join(tmpdir(), "stll-publish-target-"));
  try {
    const resultFile = path.join(scratch, "targets.json");
    const result = spawnSync(
      process.versions.bun ? "node" : process.execPath,
      [
        "--import",
        pathToFileURL(loaderRequire.resolve("tsx")).href,
        "--input-type=module",
        "--eval",
        tsdownConfigProcess,
        JSON.stringify({
          directory,
          configFile,
          toolUrl: pathToFileURL(require.resolve("tsdown")).href,
          resultFile,
        }),
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `Node tsdown configuration resolver failed: ${result.stderr.trim()}`,
      );
    const resolved: unknown = JSON.parse(readFileSync(resultFile, "utf8"));
    return resolvedTsdownTarget(resolved);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

// This is JavaScript executed by Node at the published engine floor. Keep config
// functions inside the child so JSON cannot silently discard target overrides.
const tsdownConfigProcess = `
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { directory, configFile, toolUrl, resultFile } = JSON.parse(process.argv[1]);
const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const tool = await import(toolUrl);
if (typeof tool.resolveUserConfig !== 'function')
  throw new Error('Installed tsdown does not expose its configuration resolver');
if (tool.globalLogger) tool.globalLogger.level = 'silent';
const loaded = configFile.endsWith('.json')
  ? { default: JSON.parse(readFileSync(configFile, 'utf8')) }
  : await import(pathToFileURL(configFile).href);
if (!record(loaded)) throw new Error('Invalid tsdown module');
const exported = loaded.default;
if (typeof exported === 'function')
  throw new Error('Dynamic root tsdown configurations require a supported target resolver');
const configs = Array.isArray(exported) ? exported : [exported];
const resolved = [];
const assertTsdownBuildExtensions = ${assertTsdownBuildExtensions.toString()};
for (const config of configs) {
  if (!record(config)) throw new Error('tsdown configurations must be objects');
  assertTsdownBuildExtensions(config);
  if (config.cwd !== undefined || config.workspace !== undefined || config.fromVite !== undefined)
    throw new Error('Relocated or inherited build configurations require a supported target resolver');
  const output = await tool.resolveUserConfig(
    { ...config, cwd: directory, logLevel: 'silent' }, { cwd: directory }, new Set(),
  );
  if (!Array.isArray(output)) throw new Error('Invalid tsdown resolved configuration');
  for (const entry of output) {
    if (!record(entry)) throw new Error('Invalid resolved tsdown configuration');
    assertTsdownBuildExtensions(entry);
    const input = entry.inputOptions;
    if (input !== undefined && !record(input))
      throw new Error('Dynamic tsdown inputOptions require a supported target resolver');
    const transform = record(input) ? input.transform : undefined;
    if (transform !== undefined && !record(transform))
      throw new Error('tsdown transform overrides must be an object');
    const target = record(transform) && transform.target != null ? transform.target : entry.target;
    const nonemptyIdentifiers = value => typeof value === 'string' && value.trim() !== '' && !value.includes(',');
    if (target !== undefined && !nonemptyIdentifiers(target) &&
        !(Array.isArray(target) && target.length > 0 && Array.from(target).every(nonemptyIdentifiers)))
      throw new Error('Build tool returned an unsupported resolved JavaScript target');
    resolved.push({ target, dts: { emitDtsOnly: record(entry.dts) && entry.dts.emitDtsOnly === true } });
  }
}
writeFileSync(resultFile, JSON.stringify(resolved));
`;
