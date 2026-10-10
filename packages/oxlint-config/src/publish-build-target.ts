import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  resolveManifestContract,
  type PublishTarget,
} from "./publish-contract";
import { compilerCommandSegments, decodeShellWord } from "./toolchain-packages";

const supportedTsdownVersion = "0.22.9";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const targets = (value: unknown): string[] => {
  if (value === undefined) return ["esnext"];
  if (typeof value === "string")
    return value.split(",").map((item) => item.trim());
  if (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  )
    return value.flatMap((item: string) => targets(item));
  throw new Error(
    "Build tool returned an unsupported resolved JavaScript target",
  );
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
  const build = manifest["scripts"]["build"];
  const compilerSegments = compilerCommandSegments(build).filter((words) =>
    words.some(
      (word) =>
        /(?:^|\/)(?:tsdown|tsup|tsc|tsgo|vite|esbuild|rolldown|babel|swc)(?:\.[cm]?js)?$/.test(
          decodeShellWord(word),
        ) ||
        /(?:typescript|@typescript\/native)\/bin\/tsc$/.test(
          decodeShellWord(word),
        ),
    ),
  );
  const compiler = compilerSegments.at(0);
  if (
    compilerSegments.length !== 1 ||
    compiler?.length !== 1 ||
    compiler.at(0) !== "tsdown"
  )
    throw new Error(
      "Supported publish target resolver requires tsdown without CLI overrides",
    );
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
  const tool: unknown = await import(
    pathToFileURL(require.resolve("tsdown")).href
  );
  if (!record(tool) || typeof tool["resolveUserConfig"] !== "function")
    throw new Error(
      "Installed tsdown does not expose its configuration resolver",
    );
  const loaded: unknown = configFile.endsWith(".json")
    ? { default: JSON.parse(readFileSync(configFile, "utf8")) }
    : await import(pathToFileURL(configFile).href);
  if (!record(loaded)) throw new Error("Invalid tsdown module");
  const exported = loaded["default"];
  if (typeof exported === "function")
    throw new Error(
      "Dynamic root tsdown configurations require a supported target resolver",
    );
  const userConfigs: unknown[] = Array.isArray(exported)
    ? exported
    : [exported];
  const resolved: unknown[] = [];
  for (const config of userConfigs) {
    if (!record(config))
      throw new Error("tsdown configurations must be objects");
    if (
      config["cwd"] !== undefined ||
      config["workspace"] !== undefined ||
      config["fromVite"] !== undefined
    )
      throw new Error(
        "Relocated or inherited build configurations require a supported target resolver",
      );
    const output: unknown = await tool["resolveUserConfig"](
      { ...config, cwd: directory },
      { cwd: directory },
      new Set<string>(),
    );
    if (!Array.isArray(output))
      throw new Error("Invalid tsdown resolved configuration");
    resolved.push(...output);
  }
  return resolvedTsdownTarget(resolved);
};
