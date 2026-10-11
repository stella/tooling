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
export const declarationPath = (file: string) =>
  /\.d\.(?:ts|mts|cts)(?:\.map)?$/.test(file);
const safeOutputPath = (file: string) => {
  if (
    file === "" ||
    path.posix.isAbsolute(file) ||
    /^[A-Za-z]:/.test(file) ||
    file.includes("\\") ||
    file
      .split("")
      .some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
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
    const type = entry["type"];
    const bytes = type === "chunk" ? entry["code"] : entry["source"];
    if (typeof bytes !== "string" && !(bytes instanceof Uint8Array))
      throw new Error("Declaration bundle output must contain text or bytes");
    Object.defineProperty(result, file, {
      value: `${String(type)}:${hash(bytes)}`,
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

const passiveContextMethods = new Set([
  "warn",
  "error",
  "info",
  "debug",
  "addWatchFile",
  "getWatchFiles",
  "parse",
  "resolve",
  "getModuleInfo",
  "getModuleIds",
  "getFileName",
]);
const contextData = (value: unknown): unknown => {
  if (
    value === null ||
    ["string", "number", "boolean", "undefined"].includes(typeof value)
  )
    return value;
  if (Array.isArray(value)) return Object.freeze(value.map(contextData));
  const snapshot = {};
  Object.setPrototypeOf(snapshot, null);
  for (const [key, entry] of staticEntries(value))
    Object.defineProperty(snapshot, key, {
      value: contextData(entry),
      enumerable: true,
    });
  return Object.freeze(snapshot);
};
const declarationAssetName = (value: unknown) => {
  if (typeof value !== "string")
    throw new Error("Declaration plugin requires an explicit asset fileName");
  safeOutputPath(value);
  if (!declarationPath(value))
    throw new Error(
      `Declaration plugin emitted non-declaration asset: ${value}`,
    );
  return value;
};

/** One build owns all emitter references, including assets materialized after the producer hook. */
export const createDeclarationEmissionLedger = () => {
  const references = new Map<
    string,
    { fileName: string; getFileName: () => unknown }
  >();
  const wrapContext = (host: unknown) => {
    const receiver = record(host) ? host : {};
    const hostMethod = (name: string) => {
      const method: unknown = receiver[name];
      if (typeof method !== "function")
        throw new Error(`Declaration plugin host method unavailable: ${name}`);
      return (...args: unknown[]): unknown =>
        Reflect.apply(method, receiver, args);
    };
    const methods = new Map<string, (...args: unknown[]) => unknown>();
    methods.set("emitFile", (asset: unknown) => {
      const entries = staticEntries(asset);
      if (!record(asset) || asset["type"] !== "asset")
        throw new Error("Declaration plugin may only emit assets");
      const fileName = declarationAssetName(asset["fileName"]);
      for (const [, value] of entries)
        if (typeof value === "function")
          throw new Error("Declaration plugin asset metadata must be static");
      const source = asset["source"];
      if (
        source !== undefined &&
        typeof source !== "string" &&
        !(source instanceof Uint8Array)
      )
        throw new Error(
          "Declaration plugin asset source must be text or bytes",
        );
      const getFileName = hostMethod("getFileName");
      const emitted: Record<string, unknown> = {};
      for (const [key, value] of entries) {
        const copied =
          value instanceof Uint8Array
            ? new Uint8Array(value)
            : contextData(value);
        Object.defineProperty(emitted, key, {
          value: copied,
          enumerable: true,
        });
      }
      const reference = hostMethod("emitFile")(emitted);
      if (typeof reference !== "string" || references.has(reference))
        throw new Error(
          "Declaration plugin emitted an invalid asset reference",
        );
      references.set(reference, {
        fileName,
        getFileName: () => getFileName(reference),
      });
      return reference;
    });
    methods.set("setAssetSource", (reference: unknown, source: unknown) => {
      if (typeof reference !== "string" || !references.has(reference))
        throw new Error(
          "Declaration plugin cannot update a foreign asset reference",
        );
      if (typeof source !== "string" && !(source instanceof Uint8Array))
        throw new Error(
          "Declaration plugin asset source must be text or bytes",
        );
      return hostMethod("setAssetSource")(reference, source);
    });
    const surrogate: Record<string, unknown> = {};
    Object.setPrototypeOf(surrogate, null);
    return new Proxy(surrogate, {
      get: (_target, key) => {
        if (typeof key !== "string")
          throw new Error("Declaration plugin context symbols are unsupported");
        const method = methods.get(key);
        if (method !== undefined) return method;
        if (passiveContextMethods.has(key)) {
          const forwarded = hostMethod(key);
          methods.set(key, forwarded);
          return forwarded;
        }
        const value: unknown = receiver[key];
        if (key === "meta") return contextData(value);
        if (
          value === null ||
          ["string", "number", "boolean"].includes(typeof value)
        )
          return value;
        throw new Error(
          `Declaration plugin context capability is unsupported: ${key}`,
        );
      },
      set: () => {
        throw new Error("Declaration plugin context is readonly");
      },
      defineProperty: () => {
        throw new Error("Declaration plugin context is readonly");
      },
      setPrototypeOf: () => {
        throw new Error("Declaration plugin context is readonly");
      },
    });
  };
  const audit = () => {
    for (const [reference, emission] of references) {
      const resolved = declarationAssetName(emission.getFileName());
      if (resolved !== emission.fileName)
        throw new Error(
          `Declaration plugin asset reference changed filename: ${reference}`,
        );
    }
  };
  return { wrapContext, audit };
};
export type DeclarationEmissionLedger = ReturnType<
  typeof createDeclarationEmissionLedger
>;

type GuardDeclarationHookOptions = {
  hook: unknown;
  hookName: string;
  outputDirectories: readonly string[];
  ledger?: DeclarationEmissionLedger;
};
/** Substitute a closed producer context while guarding the actual hook invocation. */
export const guardDeclarationHook = ({
  hook,
  hookName,
  outputDirectories,
  ledger = createDeclarationEmissionLedger(),
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
    const result: unknown = await Reflect.apply(
      producer,
      ledger.wrapContext(this),
      args,
    );
    if (result !== undefined)
      throw new Error(
        `Declaration plugin hook ${hookName} returned a dynamic build change`,
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
    if (["generateBundle", "writeBundle"].includes(hookName)) ledger.audit();
    return result;
  }
  return guarded;
};
