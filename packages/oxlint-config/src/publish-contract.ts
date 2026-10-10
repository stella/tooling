import { lte, parse, satisfies } from "semver";

import { consumerNodeSupportMatches } from "./consumer-node-support";

export type PublishTarget =
  | { type: "javascript"; targets: readonly string[] }
  | { type: "types-only" };

type ExportTarget =
  | string
  | null
  | ExportTarget[]
  | { [condition: string]: ExportTarget };

type EntryPoints = {
  type?: "module" | "commonjs";
  exports?: ExportTarget;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  bin?: string | Record<string, string>;
  typesVersions?: Record<string, Record<string, string[]>>;
};

export type PublishContract = {
  engines: Record<string, string>;
  peerDependencies: Record<string, string>;
  target: PublishTarget;
  entryPoints: EntryPoints;
};

export type ConsumerPolicy = { node: string; typescript: string };
export type PublishContractDiagnostic = { field: string; message: string };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const object = (value: unknown, field: string) => {
  if (!record(value)) throw new Error(`${field} must be an object`);
  return value;
};

const closedKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
) => {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error(`${field}.${key} is unsupported`);
};

const text = (value: unknown, field: string) => {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${field} must be a nonempty string`);
  return value;
};

const stringMap = (value: unknown, field: string) => {
  const result = new Map<string, string>();
  for (const [key, entry] of Object.entries(object(value, field)))
    result.set(text(key, field), text(entry, `${field}.${key}`));
  return Object.fromEntries(result);
};

const exportTarget = (value: unknown, field: string): ExportTarget => {
  if (value === null) return null;
  if (typeof value === "string") return text(value, field);
  if (Array.isArray(value))
    return value.map((entry: unknown, index) =>
      exportTarget(entry, `${field}[${index}]`),
    );
  const result = new Map<string, ExportTarget>();
  for (const [key, entry] of Object.entries(object(value, field)))
    result.set(text(key, field), exportTarget(entry, `${field}.${key}`));
  return Object.fromEntries(result);
};

const typesVersions = (value: unknown) => {
  const result = new Map<string, Record<string, string[]>>();
  for (const [range, paths] of Object.entries(object(value, "typesVersions"))) {
    const mappings = new Map<string, string[]>();
    for (const [pattern, entries] of Object.entries(
      object(paths, `typesVersions.${range}`),
    )) {
      if (!Array.isArray(entries))
        throw new Error(`typesVersions.${range}.${pattern} must be an array`);
      mappings.set(
        text(pattern, "typesVersions pattern"),
        entries.map((entry: unknown) => text(entry, "typesVersions path")),
      );
    }
    result.set(
      text(range, "typesVersions range"),
      Object.fromEntries(mappings),
    );
  }
  return Object.fromEntries(result);
};

const entryPointKeys = [
  "type",
  "exports",
  "main",
  "module",
  "types",
  "typings",
  "bin",
  "typesVersions",
] as const;

export const publishConfigOverrideKeys = entryPointKeys.filter(
  (key) => key !== "type",
);

const entryPoints = (value: unknown): EntryPoints => {
  const source = object(value, "entryPoints");
  closedKeys(source, entryPointKeys, "entryPoints");
  const result: EntryPoints = {};
  if ("type" in source) {
    if (source["type"] !== "module" && source["type"] !== "commonjs")
      throw new Error("entryPoints.type must be module or commonjs");
    result.type = source["type"];
  }
  if ("exports" in source)
    result.exports = exportTarget(source["exports"], "entryPoints.exports");
  for (const key of ["main", "module", "types", "typings"] as const)
    if (key in source) result[key] = text(source[key], `entryPoints.${key}`);
  if ("bin" in source)
    result.bin =
      typeof source["bin"] === "string"
        ? text(source["bin"], "entryPoints.bin")
        : stringMap(source["bin"], "entryPoints.bin");
  if ("typesVersions" in source)
    result.typesVersions = typesVersions(source["typesVersions"]);
  return result;
};

const publishTarget = (value: unknown): PublishTarget => {
  const source = object(value, "target");
  if (source["type"] === "types-only") {
    closedKeys(source, ["type"], "target");
    return { type: "types-only" };
  }
  if (source["type"] !== "javascript")
    throw new Error("target.type must be javascript or types-only");
  closedKeys(source, ["type", "targets"], "target");
  if (!Array.isArray(source["targets"]) || source["targets"].length === 0)
    throw new Error("target.targets must be a nonempty array");
  const targets = Array.from(source["targets"]).map((entry: unknown) => {
    const target = text(entry, "target.targets");
    if (/\s|[\u0000-\u001f\u007f]/.test(target))
      throw new Error(
        "target.targets must contain resolved target identifiers",
      );
    return target;
  });
  return { type: "javascript", targets: [...new Set(targets)].sort() };
};

export const parsePublishContract = (value: unknown): PublishContract => {
  const source = object(value, "publish contract");
  closedKeys(
    source,
    ["engines", "peerDependencies", "target", "entryPoints"],
    "publish contract",
  );
  return {
    engines: stringMap(source["engines"], "engines"),
    peerDependencies: stringMap(source["peerDependencies"], "peerDependencies"),
    target: publishTarget(source["target"]),
    entryPoints: entryPoints(source["entryPoints"]),
  };
};

type ResolveManifestContractOptions = {
  manifest: unknown;
  target: PublishTarget;
};

export const resolveManifestContract = ({
  manifest,
  target,
}: ResolveManifestContractOptions): PublishContract => {
  const source = object(manifest, "package manifest");
  const config =
    "publishConfig" in source
      ? object(source["publishConfig"], "publishConfig")
      : {};
  closedKeys(
    config,
    [...publishConfigOverrideKeys, "access", "registry"],
    "publishConfig",
  );
  for (const field of ["browser", "esnext", "es2015", "unpkg", "umd:main"])
    if (Object.hasOwn(source, field) || Object.hasOwn(config, field))
      throw new Error(`published entry field ${field} is unsupported`);
  const published: Record<string, unknown> = {};
  for (const key of entryPointKeys) {
    if (key !== "type" && key in config) published[key] = config[key];
    else if (key in source) published[key] = source[key];
  }
  if (typeof published["bin"] === "string") {
    const name = text(source["name"], "package name for bin");
    const command = name.split("/").at(-1);
    if (command === undefined || command === "")
      throw new Error("package name must determine its bin command");
    published["bin"] = { [command]: published["bin"] };
  }
  let engines: unknown = {};
  if (Object.hasOwn(source, "engines")) engines = source["engines"];
  return parsePublishContract({
    engines,
    peerDependencies: Object.hasOwn(source, "peerDependencies")
      ? source["peerDependencies"]
      : {},
    target,
    entryPoints: published,
  });
};

const consumerPolicy = (policy: ConsumerPolicy) => {
  closedKeys(
    object(policy, "consumer policy"),
    ["node", "typescript"],
    "consumer policy",
  );
  for (const [field, major] of [
    ["node", 22],
    ["typescript", 6],
  ] as const) {
    const version = parse(policy[field]);
    if (
      version === null ||
      version.version !== policy[field] ||
      version.major !== major ||
      version.prerelease.length !== 0
    )
      throw new Error(
        `consumer policy ${field} must pin an exact stable ${major}.x release`,
      );
  }
};

type CheckPublishContractOptions = ResolveManifestContractOptions & {
  contract: unknown;
  policy: ConsumerPolicy;
};

export const checkPublishContract = ({
  manifest,
  target,
  contract,
  policy,
}: CheckPublishContractOptions) => {
  consumerPolicy(policy);
  const current = resolveManifestContract({ manifest, target });
  const committed = parsePublishContract(contract);
  const diagnostics: PublishContractDiagnostic[] = [];
  const add = (field: string, message: string) =>
    diagnostics.push({ field, message });
  const compare = (field: string, expected: unknown, actual: unknown) => {
    if (
      field !== "entryPoints.exports" &&
      field !== "entryPoints.typesVersions" &&
      record(expected) &&
      record(actual)
    ) {
      for (const key of new Set([
        ...Object.keys(expected),
        ...Object.keys(actual),
      ]))
        compare(
          `${field}.${key}`,
          Object.hasOwn(expected, key) ? expected[key] : undefined,
          Object.hasOwn(actual, key) ? actual[key] : undefined,
        );
      return;
    }
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      add(field, `published ${field} differs from the committed contract`);
  };
  for (const field of [
    "engines",
    "peerDependencies",
    "target",
    "entryPoints",
  ] as const)
    compare(field, committed[field], current[field]);
  const support = (
    field: string,
    range: string | undefined,
    version: string,
  ) => {
    if (range !== undefined && !satisfies(version, range))
      add(field, `${field} must support consumer version ${version}`);
  };
  if (
    !consumerNodeSupportMatches({
      range: current.engines["node"],
      node: policy.node,
    })
  )
    add(
      "engines.node",
      `engines.node must support consumer version ${policy.node}`,
    );
  support(
    "engines.typescript",
    current.engines["typescript"],
    policy.typescript,
  );
  support(
    "peerDependencies.typescript",
    current.peerDependencies["typescript"],
    policy.typescript,
  );
  if ("bun" in current.engines)
    add("engines.bun", "published packages must not require Bun");
  for (const peer of ["bun", "bun-types", "@types/bun", "@typescript/native"])
    if (peer in current.peerDependencies)
      add(
        `peerDependencies.${peer}`,
        "published packages must not require development runtime or compiler packages",
      );
  if (current.target.type === "javascript")
    for (const selected of current.target.targets) {
      if (/^bun(?:$|[0-9])/i.test(selected)) {
        add("target", "published JavaScript must not require Bun");
        continue;
      }
      if (!/^node/i.test(selected)) continue;
      const match =
        /^node([1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?$/i.exec(
          selected,
        );
      const version =
        match === null
          ? null
          : parse(`${match[1]}.${match[2] ?? "0"}.${match[3] ?? "0"}`);
      if (version === null || !lte(version, policy.node))
        add(
          "target",
          `JavaScript target ${selected} must support consumer Node ${policy.node}`,
        );
    }
  return diagnostics;
};
