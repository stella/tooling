import { valid } from "semver";
import { parseDocument } from "yaml";

import { isCompilerPackage } from "./compiler-packages";

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
  if (isCompilerPackage(name)) return "typescript";
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

export type ChangedLockSourceProof =
  | { type: "registry" }
  | { type: "immutable"; identity: string }
  | { type: "unidentified" };
export type ChangedLockResolution = {
  tool: ToolchainChangedTool;
  name: string;
  version: string;
  dependency: string;
  location: string;
  identity: string;
  sourceProof: ChangedLockSourceProof;
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
const stableIdentity = (value: unknown): string => {
  if (Array.isArray(value)) return JSON.stringify(value.map(stableIdentity));
  if (changedRecord(value))
    return JSON.stringify(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableIdentity(entry)]),
    );
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
};
const validIntegrity = (value: string) =>
  value.split(/\s+/).some((item) => {
    const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(
      item,
    );
    const algorithm = match?.[1];
    const encoded = match?.[2];
    if (!algorithm || !encoded) return false;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) return false;
    switch (algorithm) {
      case "sha1":
        return bytes.length === 20;
      case "sha256":
        return bytes.length === 32;
      case "sha384":
        return bytes.length === 48;
      case "sha512":
        return bytes.length === 64;
      default:
        return false;
    }
  });
const lockSourceProof = (raw: unknown): ChangedLockSourceProof => {
  const sources: string[] = [];
  const evidence: string[] = [];
  const commits: string[] = [];
  const source = (value: unknown) => {
    if (typeof value !== "string") return;
    sources.push(value);
    const commit = /#(?:commit=)?([a-f0-9]{40}|[a-f0-9]{64})(?:[&#]|$)/i.exec(
      value,
    )?.[1];
    if (commit) commits.push(`commit:${commit.toLowerCase()}`);
  };
  const digest = (key: string, value: unknown) => {
    if (typeof value !== "string") return;
    if (
      (key === "integrity" && validIntegrity(value)) ||
      (key === "checksum" && /^(?:[a-f0-9]+\/)?[a-f0-9]{128}$/i.test(value)) ||
      (key === "shasum" && /^[a-f0-9]{40}$/i.test(value))
    )
      evidence.push(`${key}:${value}`);
    if (key === "commit" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value))
      commits.push(`commit:${value.toLowerCase()}`);
  };
  const metadata = (value: unknown) => {
    if (!changedRecord(value)) return;
    for (const key of ["resolved", "resolution", "tarball", "repo", "version"])
      source(value[key]);
    for (const key of ["integrity", "checksum", "shasum", "commit"])
      digest(key, value[key]);
    if (changedRecord(value["resolution"])) {
      const resolution = value["resolution"];
      for (const key of ["tarball", "repo", "directory"])
        source(resolution[key]);
      for (const key of ["integrity", "commit"]) digest(key, resolution[key]);
      if (
        resolution["type"] === "directory" ||
        typeof resolution["directory"] === "string"
      )
        sources.push("file:");
      if (resolution["type"] === "git") sources.push("git:");
    }
    if (value["link"] === true) sources.push("link:");
  };
  if (Array.isArray(raw)) {
    source(raw[0]);
    source(raw[1]);
    digest("integrity", raw[3]);
  } else if (changedRecord(raw)) {
    if (changedRecord(raw["metadata"])) {
      metadata(raw["metadata"]);
      source(raw["descriptor"]);
    } else metadata(raw);
  }
  // Directory protocols are not archive bytes; unrelated hashes cannot prove them.
  const directory = sources.some((value) => {
    if (/(?:^|@)(?:link:|portal:|workspace:)/i.test(value)) return true;
    const local = /(?:^|@)file:(.*)$/i.exec(value)?.[1];
    if (local !== undefined)
      return !/\.(?:tgz|tar\.gz)(?:[?#].*)?$/i.test(local);
    return (
      /^(?:\.{1,2}\/|\/)/.test(value) &&
      !/\.(?:tgz|tar\.gz)(?:[?#].*)?$/i.test(value)
    );
  });
  if (directory) return { type: "unidentified" };
  const gitSource = sources.some((value) =>
    /(?:^|@)(?:git(?:\+[^:]+)?:|github:|gitlab:|bitbucket:|ssh:)|(?:github\.com|gitlab\.com)[:/]|(?:^|@)git@|^[\w.-]+@(?!(?:npm|patch|file|link|portal|workspace|https?|git(?:\+[^:]+)?|github|gitlab|bitbucket|ssh):)[^/:]+:|\.git(?:#|$)/i.test(
      value,
    ),
  );
  if (gitSource) {
    const proof = commits;
    return proof.length > 0
      ? { type: "immutable", identity: stableIdentity(proof.sort()) }
      : { type: "unidentified" };
  }
  const externalArchive = sources.some(
    (value) =>
      /(?:^|@)file:/i.test(value) ||
      (/(?:^|@)https?:/i.test(value) &&
        !/(?:^|@)https:\/\/(?:registry\.npmjs\.org|registry\.yarnpkg\.com)\//i.test(
          value,
        )),
  );
  if (externalArchive && evidence.length === 0) return { type: "unidentified" };
  if (evidence.length > 0)
    return { type: "immutable", identity: stableIdentity(evidence.sort()) };
  return { type: "registry" };
};
type AddResolutionOptions = {
  raw: unknown;
  resolutions: ChangedLockResolution[];
  name: string;
  version: string;
  dependency: string;
  location: string;
};
const addResolution = ({
  raw,
  resolutions,
  name,
  version,
  dependency,
  location,
}: AddResolutionOptions) => {
  const tool = changedPackageTool(name) ?? changedPackageTool(dependency);
  if (tool === undefined) return;
  const sourceProof = lockSourceProof(raw);
  if (tool === "typescript" && sourceProof.type === "unidentified")
    throw new Error(`Compiler source has no immutable identity: ${name}`);
  const identity = stableIdentity(raw);
  if (version.startsWith("workspace:") || version.startsWith("link:")) {
    if (tool !== "shared")
      throw new Error(`Unresolved compiler workspace lock version: ${name}`);
    resolutions.push({
      tool,
      name,
      version,
      dependency,
      location,
      identity,
      sourceProof,
    });
    return;
  }
  resolutions.push({
    tool,
    name,
    version: exactVersion(version),
    identity,
    sourceProof,
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
        addResolution({
          resolutions,
          ...descriptor,
          dependency,
          location,
          raw: value,
        });
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
      const baseDescriptor = location.split("(").at(0);
      const snapshots = changedRecord(parsed["snapshots"])
        ? Object.fromEntries(
            Object.entries(parsed["snapshots"]).filter(
              ([key]) => key.split("(").at(0) === baseDescriptor,
            ),
          )
        : {};
      addResolution({
        resolutions,
        name: descriptor.name,
        raw: { descriptor: location, metadata, snapshots },
        version,
        dependency: descriptor.name,
        location,
      });
    }
  } else if (file.endsWith("yarn.lock")) {
    const classic = /^# yarn lockfile v1\s*$/m.test(text);
    let yaml = text;
    if (classic) {
      yaml = text
        .split(/\r?\n/)
        .map((line) => {
          if (line === "" || /^\s*#/.test(line)) return line;
          if (!/^\s/.test(line) && line.endsWith(":"))
            return `${JSON.stringify(line.slice(0, -1))}:`;
          const field = /^(\s+)([A-Za-z][\w-]*|"(?:[^"\\]|\\.)*") (.+)$/.exec(
            line,
          );
          if (field) return `${field[1]}${field[2]}: ${field[3]}`;
          return line;
        })
        .join("\n");
    }
    const document = parseDocument(yaml);
    if (document.errors.length > 0) throw new Error("Invalid Yarn lockfile");
    const parsed: unknown = document.toJS({ maxAliasCount: 100 });
    if (
      !changedRecord(parsed) ||
      (!classic && !changedRecord(parsed["__metadata"]))
    )
      throw new Error("Unsupported Yarn lockfile shape");
    for (const [location, metadata] of Object.entries(parsed)) {
      if (location === "__metadata") continue;
      const selectors = location.replace(/"/g, "").split(/,\s*/);
      const descriptors = selectors
        .map(packageDescriptor)
        .filter((item) => item !== undefined);
      for (const descriptor of descriptors) {
        const alias = descriptor.version.startsWith("npm:")
          ? packageDescriptor(descriptor.version.slice(4))
          : undefined;
        const dependency = descriptor.name;
        const resolution =
          changedRecord(metadata) && typeof metadata["resolution"] === "string"
            ? packageDescriptor(metadata["resolution"])
            : undefined;
        const resolutionAlias = resolution?.version.startsWith("npm:")
          ? packageDescriptor(resolution.version.slice(4))
          : undefined;
        let name = resolutionAlias?.name ?? resolution?.name ?? dependency;
        if (alias && !isCompilerPackage(name)) name = alias.name;
        const patchDescriptor = descriptor.version.startsWith("patch:")
          ? packageDescriptor(descriptor.version.slice("patch:".length))
          : undefined;
        if (
          (isCompilerPackage(name) ||
            isCompilerPackage(dependency) ||
            (patchDescriptor !== undefined &&
              isCompilerPackage(patchDescriptor.name))) &&
          (descriptor.version.startsWith("patch:") ||
            resolution?.version.startsWith("patch:"))
        )
          throw new Error(
            `Yarn compiler patch identity requires tracked patch bytes: ${location}`,
          );
        if (
          changedPackageTool(name) === undefined &&
          changedPackageTool(dependency) === undefined
        )
          continue;
        if (!changedRecord(metadata) || typeof metadata["version"] !== "string")
          throw new Error(`Missing Yarn toolchain version: ${location}`);
        if (!classic && typeof metadata["resolution"] !== "string")
          throw new Error(`Missing Yarn compiler resolution: ${location}`);
        addResolution({
          resolutions,
          name,
          version: metadata["version"],
          dependency,
          location,
          raw: { selectors, metadata },
        });
      }
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
          const ownName = metadata["name"];
          if (typeof ownName === "string" && isCompilerPackage(ownName))
            throw new Error(
              `Compiler directory lock entry has no tracked byte identity: ${location || "."}`,
            );
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
            raw: metadata,
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
            raw: metadata,
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
              raw: metadata,
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
