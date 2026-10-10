import { valid } from "semver";
import { parseDocument } from "yaml";

export const toolchainChangedTools = [
  "bun",
  "node",
  "typescript",
  "oxlint",
  "oxlint-tsgolint",
  "oxfmt",
  "shared",
] as const;
export type ToolchainChangedTool = (typeof toolchainChangedTools)[number];

export const changedRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const changedPackageTool = (
  name: string,
): ToolchainChangedTool | undefined => {
  if (
    [
      "typescript",
      "@typescript/native",
      "@typescript/native-preview",
      "typescript-compat",
      "bun-types",
      "@types/bun",
      "tsgo",
      "@typescript/tsgo",
    ].includes(name) ||
    name.startsWith("@typescript/native-")
  )
    return "typescript";
  if (name === "oxlint" || name === "oxfmt" || name === "oxlint-tsgolint")
    return name;
  if (
    name.startsWith("@stll/") ||
    name === "@oxlint/plugins" ||
    name === "lefthook"
  )
    return "shared";
  return undefined;
};

/** Compiler patch declarations retain hashes as well as referenced source paths. */
export const changedCompilerPatches = ({
  value,
  stringsArePaths,
  compilerNames,
}: {
  value: unknown;
  stringsArePaths: boolean;
  compilerNames: ReadonlySet<string>;
}) => {
  const patches: { name: string; metadata: unknown; reference?: string }[] = [];
  if (!changedRecord(value)) return patches;
  const declarations = value["patchedDependencies"];
  if (declarations === undefined) return patches;
  if (!changedRecord(declarations))
    throw new Error("Unclassifiable patchedDependencies declaration");
  for (const [descriptor, metadata] of Object.entries(declarations)) {
    const name = /^(@[^/]+\/[^@]+|[^@]+)(?:@.*)?$/.exec(descriptor)?.[1];
    if (
      !name ||
      (changedPackageTool(name) !== "typescript" && !compilerNames.has(name))
    )
      continue;
    let reference: string | undefined;
    if (typeof metadata === "string") {
      if (metadata.trim() === "")
        throw new Error(`Empty compiler patch metadata: ${descriptor}`);
      if (stringsArePaths) reference = metadata;
    } else if (changedRecord(metadata)) {
      const declaredPath = metadata["path"];
      if (declaredPath !== undefined) {
        if (typeof declaredPath !== "string")
          throw new Error(`Invalid compiler patch path: ${descriptor}`);
        reference = declaredPath;
      }
    } else throw new Error(`Invalid compiler patch metadata: ${descriptor}`);
    if (stringsArePaths && reference === undefined)
      throw new Error(`Missing compiler patch path: ${descriptor}`);
    if (reference === undefined) patches.push({ name: descriptor, metadata });
    else patches.push({ name: descriptor, metadata, reference });
  }
  return patches;
};

/** JSONC permits comments and trailing commas, never alterations inside strings. */
export const parseChangedJson = (text: string): unknown => {
  let clean = "";
  let quote = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      clean += char;
      if (char === "\\") {
        index++;
        clean += text[index] ?? "";
      } else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') {
      quote = true;
      clean += char;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      clean += "\n";
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      )
        index++;
      if (index >= text.length) throw new Error("Unterminated JSONC comment");
      index++;
      clean += " ";
      continue;
    }
    clean += char;
  }
  let result = "";
  quote = false;
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index];
    if (quote) {
      result += char;
      if (char === "\\") {
        index++;
        result += clean[index] ?? "";
      } else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') quote = true;
    if (char === ",") {
      let next = index + 1;
      while (/\s/.test(clean[next] ?? "") && next < clean.length) next++;
      if (clean[next] === "}" || clean[next] === "]") continue;
    }
    result += char;
  }
  return JSON.parse(result);
};

export type ChangedLockResolution = {
  tool: ToolchainChangedTool;
  name: string;
  version: string;
  dependency: string;
  location: string;
};
export type ChangedLock = {
  resolutions: ChangedLockResolution[];
  importers: Record<string, Record<string, string>>;
};
const packageDescriptor = (descriptor: string) => {
  const match = /^(@[^/]+\/[^@]+|[^@]+)@(.+)$/.exec(
    descriptor.replace(/^\//, ""),
  );
  const name = match?.[1];
  const version = match?.[2];
  if (!name || !version) return undefined;
  return { name, version };
};
const dependencyName = (location: string) => {
  const parts = location.split("/");
  const last = parts.at(-1);
  const scope = parts.at(-2);
  return scope?.startsWith("@") ? `${scope}/${last}` : (last ?? location);
};
const exactVersion = (value: string) => {
  const version = value.split("(")[0];
  if (version && valid(version) === version) return version;
  throw new Error(`Unresolved toolchain lock version: ${value}`);
};
type AddResolutionOptions = {
  resolutions: ChangedLockResolution[];
  name: string;
  version: string;
  dependency: string;
  location: string;
};
const addResolution = ({
  resolutions,
  name,
  version,
  dependency,
  location,
}: AddResolutionOptions) => {
  const tool = changedPackageTool(name) ?? changedPackageTool(dependency);
  if (tool === undefined) return;
  if (version.startsWith("workspace:") || version.startsWith("link:")) {
    if (tool !== "shared")
      throw new Error(`Unresolved compiler workspace lock version: ${name}`);
    resolutions.push({ tool, name, version, dependency, location });
    return;
  }
  resolutions.push({
    tool,
    name,
    version: exactVersion(version),
    dependency,
    location,
  });
};
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const;
const importerDependencies = (value: unknown) => {
  if (!changedRecord(value)) throw new Error("Invalid lockfile importer");
  const result: Record<string, string> = {};
  for (const field of dependencyFields) {
    const dependencies = value[field];
    if (dependencies === undefined) continue;
    if (!changedRecord(dependencies))
      throw new Error("Invalid lockfile dependency table");
    for (const [name, metadata] of Object.entries(dependencies)) {
      if (typeof metadata === "string") result[name] = metadata;
      else if (
        changedRecord(metadata) &&
        typeof metadata["version"] === "string"
      )
        result[name] = metadata["version"];
      else if (changedPackageTool(name) !== undefined)
        throw new Error(`Unresolved lockfile importer dependency: ${name}`);
    }
  }
  return result;
};

export const parseChangedLock = ({
  file,
  text,
}: {
  file: string;
  text: string;
}): ChangedLock => {
  const resolutions: ChangedLockResolution[] = [];
  const importers: Record<string, Record<string, string>> = {};
  if (file.endsWith("bun.lock")) {
    const parsed = parseChangedJson(text);
    if (
      !changedRecord(parsed) ||
      ![0, 1].includes(Number(parsed["lockfileVersion"])) ||
      !changedRecord(parsed["packages"]) ||
      !changedRecord(parsed["workspaces"])
    )
      throw new Error("Unsupported Bun lockfile shape");
    for (const [directory, workspace] of Object.entries(parsed["workspaces"]))
      importers[directory || "."] = importerDependencies(workspace);
    for (const [location, value] of Object.entries(parsed["packages"])) {
      const dependency = dependencyName(location);
      const first: unknown = Array.isArray(value) ? value.at(0) : undefined;
      const descriptor =
        typeof first === "string" ? packageDescriptor(first) : undefined;
      if (descriptor !== undefined)
        addResolution({ resolutions, ...descriptor, dependency, location });
      else if (changedPackageTool(dependency) !== undefined)
        throw new Error(`Invalid Bun toolchain lock entry: ${location}`);
    }
  } else if (file.endsWith("pnpm-lock.yaml")) {
    const document = parseDocument(text);
    if (document.errors.length > 0)
      throw new Error("Invalid pnpm lockfile YAML");
    const parsed: unknown = document.toJS({ maxAliasCount: 100 });
    if (
      !changedRecord(parsed) ||
      ![5.4, 6, 9].includes(Number(parsed["lockfileVersion"]))
    )
      throw new Error("Unsupported pnpm lockfile shape");
    const sourceImporters = changedRecord(parsed["importers"])
      ? parsed["importers"]
      : { ".": parsed };
    for (const [directory, importer] of Object.entries(sourceImporters))
      importers[directory] = importerDependencies(importer);
    const packages = parsed["packages"] ?? {};
    if (!changedRecord(packages))
      throw new Error("Invalid pnpm lockfile packages");
    for (const [location, metadata] of Object.entries(packages)) {
      let descriptor = packageDescriptor(location);
      if (descriptor === undefined) {
        const legacy = /^(.*)\/([^/]+)$/.exec(location.replace(/^\//, ""));
        if (legacy?.[1] && legacy[2])
          descriptor = { name: legacy[1], version: legacy[2] };
      }
      if (!descriptor) continue;
      const version =
        changedRecord(metadata) && typeof metadata["version"] === "string"
          ? metadata["version"]
          : descriptor.version;
      addResolution({
        resolutions,
        name: descriptor.name,
        version,
        dependency: descriptor.name,
        location,
      });
    }
  } else {
    const parsed = parseChangedJson(text);
    if (
      !changedRecord(parsed) ||
      ![1, 2, 3].includes(Number(parsed["lockfileVersion"]))
    )
      throw new Error("Unsupported npm lockfile shape");
    if (changedRecord(parsed["packages"])) {
      for (const [location, metadata] of Object.entries(parsed["packages"])) {
        if (!changedRecord(metadata))
          throw new Error("Invalid npm lockfile package");
        if (!location.includes("node_modules/")) {
          importers[location || "."] = importerDependencies(metadata);
          continue;
        }
        const dependency = dependencyName(location);
        const name =
          typeof metadata["name"] === "string" ? metadata["name"] : dependency;
        if (metadata["link"] === true) {
          addResolution({
            resolutions,
            name,
            version: `link:${String(metadata["resolved"])}`,
            dependency,
            location,
          });
          continue;
        }
        if (typeof metadata["version"] === "string")
          addResolution({
            resolutions,
            name,
            version: metadata["version"],
            dependency,
            location,
          });
        else if (
          changedPackageTool(name) !== undefined ||
          changedPackageTool(dependency) !== undefined
        )
          throw new Error(`Missing npm toolchain version: ${name}`);
      }
    } else if (changedRecord(parsed["dependencies"])) {
      const visit = ({
        dependencies,
        parent,
      }: {
        dependencies: Record<string, unknown>;
        parent: string;
      }) => {
        for (const [dependency, metadata] of Object.entries(dependencies)) {
          if (!changedRecord(metadata))
            throw new Error("Invalid npm lockfile dependency");
          const location = `${parent}node_modules/${dependency}`;
          const version = metadata["version"];
          const alias =
            typeof version === "string" && version.startsWith("npm:")
              ? packageDescriptor(version.slice(4))
              : undefined;
          if (typeof version === "string")
            addResolution({
              resolutions,
              name: alias?.name ?? dependency,
              version: alias?.version ?? version,
              dependency,
              location,
            });
          else if (changedPackageTool(dependency) !== undefined)
            throw new Error(`Missing npm toolchain version: ${dependency}`);
          if (changedRecord(metadata["dependencies"]))
            visit({
              dependencies: metadata["dependencies"],
              parent: `${location}/`,
            });
        }
      };
      visit({ dependencies: parsed["dependencies"], parent: "" });
    } else throw new Error("Missing npm lockfile dependency resolutions");
  }
  return { resolutions, importers };
};
