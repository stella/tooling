import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const staticEntries = (value: unknown): [string, unknown][] => {
  if (
    !record(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("Declaration options must be plain static records");
  return Reflect.ownKeys(value).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !("value" in descriptor))
      throw new Error(
        "Declaration options cannot contain accessors or symbols",
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
    throw new Error("Declaration paths must stay within the package");
  return value;
};
const patterns = (value: unknown) => {
  if (typeof value === "string") return Object.freeze([relativePattern(value)]);
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("Declaration include/exclude must be static paths");
  return Object.freeze(value.map(relativePattern));
};

/** Closed helper options; callbacks, custom compilers and output relocation are unsupported. */
export type ReviewedViteDtsOptions = {
  include?: readonly string[];
  exclude?: readonly string[];
  entryRoot?: string;
  compilerOptions?: Readonly<{ declarationMap: false }>;
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
      default:
        throw new Error(`Unreviewed declaration option: ${key}`);
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
    throw new Error("Declaration emit produced an unsafe output path");
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

type DeclarationOutputOptions = {
  before: DeclarationOutputSnapshot;
  after: DeclarationOutputSnapshot;
};
/** Declaration emit may only add or change declaration files; every existing non-declaration is immutable. */
export const assertDeclarationOnlyOutput = ({
  before,
  after,
}: DeclarationOutputOptions) => {
  for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
    safeOutputPath(file);
    if (!declarationPath(file) && before[file] !== after[file])
      throw new Error(
        `Declaration emit changed non-declaration output: ${file}`,
      );
  }
};
