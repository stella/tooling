import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";

import { workspaceContains } from "./toolchain-workspaces";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const catalogMapping = (value: unknown, field: string) => {
  if (!record(value)) throw new Error(`${field} must be a mapping`);
  const entries = new Map<string, string>();
  for (const [name, specifier] of Object.entries(value)) {
    if (name === "" || typeof specifier !== "string" || specifier.trim() === "")
      throw new Error(`${field} must contain nonempty package specifiers`);
    entries.set(name, specifier);
  }
  return Object.fromEntries(entries);
};

export const catalogState = (source: Record<string, unknown>, file: string) => {
  const result: {
    catalog?: Record<string, string>;
    catalogs?: Record<string, Record<string, string>>;
  } = {};
  if (Object.hasOwn(source, "catalog"))
    result.catalog = catalogMapping(source["catalog"], `${file}: catalog`);
  if (Object.hasOwn(source, "catalogs")) {
    if (!record(source["catalogs"]))
      throw new Error(`${file}: catalogs must be a mapping`);
    const named = new Map<string, Record<string, string>>();
    for (const [name, entries] of Object.entries(source["catalogs"])) {
      if (name === "")
        throw new Error(`${file}: catalog names must be nonempty`);
      named.set(name, catalogMapping(entries, `${file}: catalogs.${name}`));
    }
    result.catalogs = Object.fromEntries(named);
  }
  return result;
};

export const bunCatalogState = (manifest: Record<string, unknown>) => {
  const sources = [manifest];
  if (record(manifest["workspaces"])) sources.push(manifest["workspaces"]);
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    const state = catalogState(source, "package.json");
    for (const [field, value] of Object.entries(state)) {
      if (
        Object.hasOwn(merged, field) &&
        !isDeepStrictEqual(merged[field], value)
      )
        throw new Error(`conflicting Bun ${field} definitions in package.json`);
      merged[field] = value;
    }
  }
  return catalogState(merged, "package.json");
};

export const pnpmWorkspaceState = (source: string, file: string) => {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length !== 0)
    throw new Error(`invalid pnpm workspace: ${file}`);
  const workspace: unknown = document.toJS({ maxAliasCount: 100 });
  if (!record(workspace)) throw new Error(`invalid pnpm workspace: ${file}`);
  const packages = workspace["packages"];
  if (
    packages !== undefined &&
    (!Array.isArray(packages) ||
      !packages.every((entry: unknown) => typeof entry === "string"))
  )
    throw new Error(`invalid pnpm workspace packages: ${file}`);
  return { packages: packages ?? [], ...catalogState(workspace, file) };
};

type ResolveConsumerCatalogOptions = {
  directory: string;
  name: string;
  specifier: string;
  files: Record<string, string>;
};
export const resolveConsumerCatalog = ({
  directory: inputDirectory,
  name,
  specifier,
  files,
}: ResolveConsumerCatalogOptions) => {
  let directory = inputDirectory;
  while (true) {
    const yamlFile = path.posix.join(directory, "pnpm-workspace.yaml");
    const yaml = files[yamlFile];
    const manifestFile = path.posix.join(directory, "package.json");
    const json = files[manifestFile];
    let state: ReturnType<typeof catalogState> | undefined;
    let patterns: string[] = [];
    if (yaml !== undefined) {
      const workspace = pnpmWorkspaceState(yaml, yamlFile);
      state = catalogState(workspace, yamlFile);
      patterns = workspace.packages;
    } else if (json !== undefined) {
      const manifest: unknown = JSON.parse(json);
      if (!record(manifest))
        throw new Error(`invalid catalog owner: ${manifestFile}`);
      const declaration = manifest["workspaces"];
      if (directory === "." || declaration !== undefined) {
        state = bunCatalogState(manifest);
        const packages = record(declaration)
          ? declaration["packages"]
          : declaration;
        if (
          packages !== undefined &&
          (!Array.isArray(packages) ||
            !packages.every((entry: unknown) => typeof entry === "string"))
        )
          throw new Error(`invalid catalog owner packages: ${manifestFile}`);
        patterns = packages ?? [];
      }
    }
    if (state !== undefined) {
      if (
        !workspaceContains({
          directory,
          file: path.posix.join(inputDirectory, "package.json"),
          patterns,
          rootMembership: "implicit",
        })
      )
        throw new Error(
          `catalog dependency ${name} is outside nearest workspace owner ${directory}`,
        );
      const catalogName = specifier.slice("catalog:".length) || "default";
      const named = state.catalogs;
      const namedEntries =
        named !== undefined && Object.hasOwn(named, catalogName)
          ? named[catalogName]
          : undefined;
      const entries =
        catalogName === "default"
          ? (state.catalog ?? namedEntries)
          : namedEntries;
      const resolved =
        entries !== undefined && Object.hasOwn(entries, name)
          ? entries[name]
          : undefined;
      if (resolved === undefined)
        throw new Error(
          `unresolved catalog dependency ${name} in workspace ${directory}`,
        );
      return resolved;
    }
    if (directory === ".") break;
    directory = path.posix.dirname(directory);
  }
  throw new Error(
    `unresolved catalog dependency ${name}: no tracked workspace owner`,
  );
};
