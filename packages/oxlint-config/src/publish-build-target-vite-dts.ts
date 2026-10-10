import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const reviewedViteDtsVersions = {
  "vite-plugin-dts": "5.0.3",
  "unplugin-dts": "1.0.3",
} as const;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const staticEntries = (value: unknown): [string, unknown][] => {
  if (
    !record(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("Declaration plugin options must be plain static records");
  return Reflect.ownKeys(value).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !("value" in descriptor))
      throw new Error(
        "Declaration plugin options cannot contain accessors or symbols",
      );
    return [key, descriptor.value];
  });
};

const relativePattern = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.split("/").includes("..")
  )
    throw new Error("Declaration plugin paths must stay within the package");
  return value;
};
const patterns = (value: unknown) => {
  if (typeof value === "string") return relativePattern(value);
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("Declaration plugin include/exclude must be static paths");
  return Object.freeze(value.map(relativePattern));
};

/** Closed factory options; callbacks, custom compilers and output relocation are unsupported. */
export type ReviewedViteDtsOptions = {
  include?: string | readonly string[];
  exclude?: string | readonly string[];
  entryRoot?: string;
  pathsToAliases?: boolean;
  compilerOptions?: Readonly<{ declarationMap: false }>;
  strictOutput?: true;
  declarationOnly?: false;
};
export const reviewedViteDtsOptions = (value: unknown = {}) => {
  const result: ReviewedViteDtsOptions = {};
  for (const [key, entry] of staticEntries(value)) {
    switch (key) {
      case "include":
      case "exclude":
        result[key] = patterns(entry);
        break;
      case "entryRoot":
        result.entryRoot = relativePattern(entry);
        break;
      case "pathsToAliases":
        if (typeof entry !== "boolean")
          throw new Error("pathsToAliases must be a static boolean");
        result.pathsToAliases = entry;
        break;
      case "compilerOptions": {
        const entries = staticEntries(entry);
        if (
          entries.length !== 1 ||
          entries.at(0)?.[0] !== "declarationMap" ||
          entries.at(0)?.[1] !== false
        )
          throw new Error(
            "Only compilerOptions.declarationMap=false is reviewed",
          );
        result.compilerOptions = Object.freeze({ declarationMap: false });
        break;
      }
      case "strictOutput":
        if (entry !== true)
          throw new Error("Declaration output containment cannot be disabled");
        result.strictOutput = true;
        break;
      case "declarationOnly":
        if (entry !== false)
          throw new Error(
            "Declaration plugin cannot remove JavaScript outputs",
          );
        result.declarationOnly = false;
        break;
      default:
        throw new Error(`Unreviewed declaration plugin option: ${key}`);
    }
  }
  return Object.freeze(result);
};

export type DeclarationOutputSnapshot = Readonly<Record<string, string>>;
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const declarationPath = (file: string) =>
  /\.d\.(?:ts|mts)(?:\.map)?$/.test(file);
const safeOutputPath = (file: string) => {
  if (
    file === "" ||
    path.posix.isAbsolute(file) ||
    /^[A-Za-z]:/.test(file) ||
    file.includes("\\") ||
    file.split("/").includes("..")
  )
    throw new Error("Declaration plugin emitted an unsafe output path");
};

/** Capture bytes now; later mutations cannot alter this frozen snapshot. */
export const snapshotDeclarationDirectory = (
  directory: string,
): DeclarationOutputSnapshot => {
  const result: Record<string, string> = {};
  if (lstatSync(directory, { throwIfNoEntry: false }) === undefined)
    return Object.freeze(result);
  const visit = (current: string) => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink())
      throw new Error("Declaration output cannot contain symlinks");
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current))
        visit(path.join(current, entry));
      return;
    }
    if (!stat.isFile())
      throw new Error("Declaration output must contain regular files");
    Object.defineProperty(
      result,
      path.relative(directory, current).split(path.sep).join("/"),
      { value: hash(readFileSync(current)), enumerable: true },
    );
  };
  visit(directory);
  return Object.freeze(result);
};

const snapshotValue = (value: unknown): unknown => {
  if (value instanceof Uint8Array)
    return ["bytes", Buffer.from(value).toString("base64")];
  if (Array.isArray(value)) return value.map(snapshotValue);
  if (
    record(value) &&
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    const fields = [
      "version",
      "sources",
      "names",
      "mappings",
      "sourcesContent",
      "file",
      "sourceRoot",
    ];
    const entries = fields.flatMap((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) return [];
      if (!("value" in descriptor))
        throw new Error("Unsupported source map accessor");
      return [[key, descriptor.value]];
    });
    if (
      Object.getOwnPropertyDescriptor(value, "version")?.value !== 3 ||
      !Object.hasOwn(value, "mappings")
    )
      throw new Error("Unsupported declaration bundle metadata prototype");
    for (const key of Reflect.ownKeys(value))
      if (typeof key !== "string" || !fields.includes(key))
        throw new Error("Unsupported source map metadata");
    return entries.map(([key, entry]) => [key, snapshotValue(entry)]);
  }
  if (record(value))
    return staticEntries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, snapshotValue(entry)]);
  if (value === undefined) return ["undefined"];
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  throw new Error("Unsupported declaration bundle metadata");
};
export const snapshotDeclarationBundle = (
  bundle: unknown,
): DeclarationOutputSnapshot => {
  const result: Record<string, string> = {};
  for (const [file, entry] of staticEntries(bundle)) {
    safeOutputPath(file);
    if (
      !record(entry) ||
      entry["fileName"] !== file ||
      !["asset", "chunk"].includes(String(entry["type"]))
    )
      throw new Error("Invalid declaration bundle entry");
    if (declarationPath(file) && entry["type"] !== "asset")
      throw new Error("Declarations must be emitted as assets");
    Object.defineProperty(result, file, {
      value: hash(JSON.stringify(snapshotValue(entry))),
      enumerable: true,
    });
  }
  return Object.freeze(result);
};

type DeclarationOutputOptions = {
  before: DeclarationOutputSnapshot;
  after: DeclarationOutputSnapshot;
};
/** This plugin may only add or change declaration files; every existing non-declaration is immutable. */
export const assertDeclarationOnlyOutput = ({
  before,
  after,
}: DeclarationOutputOptions) => {
  for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
    safeOutputPath(file);
    if (!declarationPath(file) && before[file] !== after[file])
      throw new Error(
        `Declaration plugin changed non-declaration output: ${file}`,
      );
  }
};

type GuardDeclarationHookOptions = {
  hook: unknown;
  hookName: string;
  outputDirectories: readonly string[];
};
/** Preserve receiver, arguments and result while guarding the actual hook invocation. */
export const guardDeclarationHook = ({
  hook,
  hookName,
  outputDirectories,
}: GuardDeclarationHookOptions) => {
  if (typeof hook !== "function")
    throw new Error("Invalid reviewed declaration hook");
  const producer = hook;
  async function guarded(this: unknown, ...args: unknown[]) {
    const beforeDirectories = outputDirectories.map(
      snapshotDeclarationDirectory,
    );
    const bundle = ["generateBundle", "writeBundle"].includes(hookName)
      ? args.at(1)
      : undefined;
    const beforeBundle =
      bundle === undefined ? undefined : snapshotDeclarationBundle(bundle);
    const result: unknown = await Reflect.apply(producer, this, args);
    if (result !== undefined)
      throw new Error(
        `Declaration hook ${hookName} returned a dynamic build change`,
      );
    if (beforeBundle !== undefined)
      assertDeclarationOnlyOutput({
        before: beforeBundle,
        after: snapshotDeclarationBundle(bundle),
      });
    for (const [index, directory] of outputDirectories.entries()) {
      const before = beforeDirectories.at(index);
      if (before === undefined)
        throw new Error("Missing declaration output snapshot");
      assertDeclarationOnlyOutput({
        before,
        after: snapshotDeclarationDirectory(directory),
      });
    }
    return result;
  }
  return guarded;
};
