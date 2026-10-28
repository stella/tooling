import path from "node:path";
import picomatch from "picomatch";
import { parse as parseToml } from "smol-toml";
import {
  isNode,
  LineCounter,
  parseAllDocuments,
  parseDocument,
  Scalar,
  stringify,
} from "yaml";

import {
  containerDocumentImages,
  isComposeDefinitionPath,
  isKubernetesDefinitionPath,
} from "./toolchain-container-inputs";
import { ownedDockerImageAliases } from "./toolchain-images";
import {
  dependabotManifestEcosystem,
  isDependabotGithubActionsPath,
  isDockerDefinitionPath,
  isPythonDependencyManifest,
  javascriptDependencyLockfiles,
  pythonDependencyManifestKind,
} from "./toolchain-inputs";
import { workspaceContains } from "./toolchain-workspaces";

export const dependabotRules = ["dependabot-policy"] as const;

// https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#package-ecosystem
export const supportedDependabotEcosystems = [
  "bazel",
  "bun",
  "bundler",
  "cargo",
  "composer",
  "conda",
  "deno",
  "devcontainers",
  "docker",
  "docker-compose",
  "dotnet-sdk",
  "elm",
  "gitsubmodule",
  "github-actions",
  "gomod",
  "gradle",
  "helm",
  "julia",
  "maven",
  "mix",
  "nix",
  "npm",
  "nuget",
  "opentofu",
  "pip",
  "pre-commit",
  "pub",
  "rust-toolchain",
  "sbt",
  "swift",
  "terraform",
  "uv",
  "vcpkg",
] as const;
export type DependabotEcosystem =
  (typeof supportedDependabotEcosystems)[number];
const isDependabotEcosystem = (value: string): value is DependabotEcosystem =>
  supportedDependabotEcosystems.some((ecosystem) => ecosystem === value);

type DependabotPolicy = {
  schedule: { interval: string; day: string; time: string; timezone: string };
  cooldown: { defaultDays: number };
  actionGroups: Record<string, { patterns: readonly string[] }>;
  groups: Record<
    string,
    { patterns: readonly string[]; updateTypes: readonly string[] }
  >;
  ignoredPackages: readonly string[];
  ignoredActions: readonly string[];
  ignoredImages: readonly string[];
};

type DependabotGroup = {
  patterns: readonly string[];
  updateTypes?: readonly string[] | undefined;
  excludePatterns?: readonly string[] | undefined;
};

const tauriPatterns = (ecosystem: string): readonly string[] => {
  if (ecosystem === "cargo") return ["tauri", "tauri-*"];
  if (ecosystem === "bun" || ecosystem === "npm") return ["@tauri-apps/*"];
  return [];
};

const ownsTauriDependencies = (
  ecosystem: string,
  files: Readonly<Record<string, string>>,
) => {
  const patterns = tauriPatterns(ecosystem);
  if (patterns.length === 0) return false;
  const matches = picomatch([...patterns]);
  const dependencyTables =
    ecosystem === "cargo"
      ? ["dependencies", "dev-dependencies", "build-dependencies"]
      : [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
        ];
  const owns = (owner: unknown) => {
    if (!record(owner)) return false;
    for (const key of dependencyTables) {
      const dependencies = owner[key];
      if (!record(dependencies)) continue;
      if (
        Object.entries(dependencies).some(([name, value]) =>
          matches(
            record(value) && typeof value["package"] === "string"
              ? value["package"]
              : name,
          ),
        )
      )
        return true;
    }
    return false;
  };
  return Object.entries(files).some(([file, text]) => {
    const manifest = ecosystem === "cargo" ? "Cargo.toml" : "package.json";
    if (path.posix.basename(file) !== manifest || !text.includes("tauri"))
      return false;
    const manifestValue: unknown =
      ecosystem === "cargo" ? parseToml(text) : JSON.parse(text);
    if (owns(manifestValue)) return true;
    if (ecosystem !== "cargo" || !record(manifestValue)) return false;
    // Only Cargo's dependency owners count; package metadata is arbitrary data.
    if (owns(manifestValue["workspace"])) return true;
    const targets = manifestValue["target"];
    return record(targets) && Object.values(targets).some(owns);
  });
};

type DependabotGroupsOptions = {
  ecosystem: string;
  policy: DependabotPolicy;
  files: Readonly<Record<string, string>>;
};

/** Alignment cohorts precede semver groups so coupled major updates stay together. */
const groupsFor = ({
  ecosystem,
  policy,
  files,
}: DependabotGroupsOptions): [string, DependabotGroup][] => {
  const alignment = ownsTauriDependencies(ecosystem, files)
    ? tauriPatterns(ecosystem)
    : [];
  return [
    ...(ecosystem === "github-actions"
      ? Object.entries(policy.actionGroups)
      : []),
    ...(alignment.length === 0
      ? []
      : ([
          [
            "tauri",
            { patterns: alignment, updateTypes: ["major", "minor", "patch"] },
          ],
        ] satisfies [string, DependabotGroup][])),
    ...Object.entries(policy.groups).map(
      ([name, group]): [string, DependabotGroup] => [
        name,
        alignment.length === 0
          ? group
          : { ...group, excludePatterns: alignment },
      ],
    ),
  ];
};

type Diagnostic = {
  rule: (typeof dependabotRules)[number];
  path: string;
  line: number;
  message: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((entry: unknown) => typeof entry === "string");

const sameStrings = (value: unknown, expected: readonly string[]) => {
  if (!strings(value) || value.length !== expected.length) return false;
  const sortedExpected = [...expected].sort();
  return [...value]
    .sort()
    .every((entry, index) => entry === sortedExpected[index]);
};

// Version-update types only: security updates stay enabled for every ignore.
export const dependabotIgnoreUpdateTypes = [
  "version-update:semver-major",
  "version-update:semver-minor",
  "version-update:semver-patch",
] as const;
export type DependabotIgnoreUpdateType =
  (typeof dependabotIgnoreUpdateTypes)[number];
const isIgnoreUpdateType = (
  value: unknown,
): value is DependabotIgnoreUpdateType =>
  dependabotIgnoreUpdateTypes.some((updateType) => updateType === value);

const versionIgnore = (entry: unknown, updateTypes: readonly string[]) =>
  record(entry) &&
  Object.keys(entry).length === 2 &&
  typeof entry["dependency-name"] === "string" &&
  sameStrings(entry["update-types"], updateTypes);

const versionOnlyIgnore = (entry: unknown) =>
  versionIgnore(entry, dependabotIgnoreUpdateTypes);

/** A reviewed repository decision to skip some version updates of one dependency. */
export type DependabotIgnoreDeclaration = {
  readonly ecosystem: DependabotEcosystem;
  /** Dependabot `dependency-name`; `*` is the only wildcard. */
  readonly dependency: string;
  /** Nonempty, unique and in canonical major, minor, patch order. */
  readonly updateTypes: readonly [
    DependabotIgnoreUpdateType,
    ...DependabotIgnoreUpdateType[],
  ];
  readonly reason: string;
};

const ignoreDeclarationKeys = [
  "ecosystem",
  "dependency",
  "updateTypes",
  "reason",
] as const;

/** Parse `dependabotIgnores` from stll-toolchain.json; malformed decisions fail closed. */
export const parseDependabotIgnores = (
  input: unknown,
): DependabotIgnoreDeclaration[] => {
  if (input === undefined) return [];
  if (!Array.isArray(input))
    throw new Error("dependabotIgnores must be an array");
  const result: DependabotIgnoreDeclaration[] = [];
  const keys = new Set<string>();
  for (const entry of input) {
    if (
      !record(entry) ||
      Object.keys(entry).some(
        (key) => !ignoreDeclarationKeys.some((known) => known === key),
      ) ||
      typeof entry["reason"] !== "string" ||
      entry["reason"].trim() === ""
    )
      throw new Error(
        "each Dependabot ignore requires ecosystem, dependency, updateTypes and a nonempty reason only",
      );
    const ecosystem = entry["ecosystem"];
    if (typeof ecosystem !== "string" || !isDependabotEcosystem(ecosystem))
      throw new Error(
        `unsupported Dependabot ignore ecosystem: ${String(ecosystem)}`,
      );
    const dependency = entry["dependency"];
    if (
      typeof dependency !== "string" ||
      !/^[^\s?[\]{}!]+$/.test(dependency) ||
      /^\*+$/.test(dependency)
    )
      throw new Error(
        `Dependabot ignore dependency must name a dependency; * is the only wildcard: ${String(dependency)}`,
      );
    const updateTypes = entry["updateTypes"];
    if (
      !Array.isArray(updateTypes) ||
      !updateTypes.every(isIgnoreUpdateType) ||
      new Set(updateTypes).size !== updateTypes.length
    )
      throw new Error(
        `Dependabot ignore ${dependency} requires unique update types from ${dependabotIgnoreUpdateTypes.join(", ")}`,
      );
    const [first, ...rest] = dependabotIgnoreUpdateTypes.filter((updateType) =>
      updateTypes.includes(updateType),
    );
    if (first === undefined)
      throw new Error(
        `Dependabot ignore ${dependency} requires at least one update type`,
      );
    const key = JSON.stringify([ecosystem, dependency]);
    if (keys.has(key))
      throw new Error(
        `duplicate Dependabot ignore: ${ecosystem} ${dependency}`,
      );
    keys.add(key);
    result.push({
      ecosystem,
      dependency,
      updateTypes: [first, ...rest],
      reason: entry["reason"],
    });
  }
  return result;
};

/**
 * Read only `dependabotIgnores` from stll-toolchain.json text: stll-dependabot must not
 * fail on unrelated declarations, which stll-toolchain-check validates.
 */
export const readDependabotIgnores = (toolchain: string | undefined) => {
  if (toolchain === undefined) return [];
  const parsed: unknown = JSON.parse(toolchain);
  if (!record(parsed)) throw new Error("stll-toolchain.json must be an object");
  return parseDependabotIgnores(parsed["dependabotIgnores"]);
};

const dependencyPattern = (dependency: string) =>
  new RegExp(
    `^${dependency
      .split("*")
      .map((part) => part.replace(/[.+^${}()|[\]\\/?]/g, "\\$&"))
      .join(".*")}$`,
  );

/** Code-unit order keeps generated bytes independent of the host locale. */
const byDependency = (
  left: DependabotIgnoreDeclaration,
  right: DependabotIgnoreDeclaration,
) => {
  if (left.dependency === right.dependency) return 0;
  return left.dependency < right.dependency ? -1 : 1;
};

const directoryOf = (file: string) => {
  const directory = path.posix.dirname(file);
  return directory === "." ? "/" : `/${directory}`;
};

const workspaceManifests = {
  npm: "package.json",
  cargo: "Cargo.toml",
  uv: "pyproject.toml",
} as const;

const workspaceTable = (
  parsed: Record<string, unknown>,
  ecosystem: keyof typeof workspaceManifests,
) => {
  switch (ecosystem) {
    case "npm":
      return parsed["workspaces"];
    case "cargo":
      return parsed["workspace"];
    case "uv": {
      const tool = parsed["tool"];
      const uv = record(tool) ? tool["uv"] : undefined;
      return record(uv) ? uv["workspace"] : undefined;
    }
    default: {
      const unexpected: never = ecosystem;
      throw new Error("unknown workspace ecosystem", { cause: unexpected });
    }
  }
};

const declaresJavascriptInstallation = (text: string | undefined) => {
  try {
    const manifest: unknown = JSON.parse(text ?? "");
    if (!record(manifest)) return false;
    if (typeof manifest["packageManager"] === "string") return true;
    return [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ].some((field) => {
      const dependencies = manifest[field];
      return record(dependencies) && Object.keys(dependencies).length > 0;
    });
  } catch {
    // Manifest validation reports invalid JSON independently.
    return false;
  }
};

/** Dependency-bearing projects and workspace members need coverage without requiring a lock. */
const workspaceRoots = (
  files: Record<string, string>,
  ecosystem: keyof typeof workspaceManifests,
) => {
  const manifests = Object.keys(files).filter(
    (file) =>
      path.posix.basename(file) === workspaceManifests[ecosystem] ||
      (ecosystem === "npm" &&
        path.posix.basename(file) === "pnpm-workspace.yaml"),
  );
  const workspaces = new Map<string, string[]>();
  const npmWorkspaceErrors = new Map<string, Error>();
  for (const file of manifests) {
    if (ecosystem === "npm") {
      const directory = path.posix.dirname(file);
      const workspaceFile = path.posix.join(directory, "pnpm-workspace.yaml");
      const text = files[workspaceFile];
      if (text !== undefined) {
        try {
          const document = parseDocument(text);
          if (document.errors.length > 0)
            throw new Error(`${workspaceFile}:1: invalid pnpm workspace YAML`);
          const parsed: unknown = document.toJS({ maxAliasCount: 100 });
          if (!record(parsed))
            throw new Error(
              `${workspaceFile}:1: pnpm workspace must contain an object`,
            );
          const patterns = parsed["packages"] ?? [];
          if (!strings(patterns))
            throw new Error(
              `${workspaceFile}:1: pnpm packages must be a string array`,
            );
          workspaces.set(
            directory,
            patterns.map((pattern) =>
              pattern.startsWith("!")
                ? `!${path.posix.normalize(pattern.slice(1))}`
                : path.posix.normalize(pattern),
            ),
          );
        } catch (error) {
          npmWorkspaceErrors.set(
            directory,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
        continue;
      }
    }
    try {
      const parsed: unknown =
        ecosystem === "npm"
          ? JSON.parse(files[file] ?? "")
          : parseToml(files[file] ?? "");
      if (!record(parsed)) continue;
      if (
        ecosystem === "npm" &&
        typeof parsed["packageManager"] === "string" &&
        parsed["packageManager"].startsWith("pnpm@")
      )
        continue;
      const value = workspaceTable(parsed, ecosystem);
      const patterns = record(value)
        ? value[ecosystem === "npm" ? "packages" : "members"]
        : value;
      const members =
        ecosystem === "cargo" && record(value) && patterns === undefined
          ? []
          : patterns;
      if (strings(members)) {
        const excluded =
          ecosystem !== "npm" && record(value) && strings(value["exclude"])
            ? value["exclude"].map((pattern) => `!${pattern}`)
            : [];
        workspaces.set(path.posix.dirname(file), [...members, ...excluded]);
      }
    } catch {
      // Other toolchain rules validate manifests; retain the update root here.
    }
  }
  const implicitCargoMembers = new Map<string, Set<string>>();
  const declaredMember = (
    root: string,
    patterns: string[],
    directory: string,
  ) => {
    const relative = path.posix.relative(root, directory);
    if (relative === "" || relative === ".." || relative.startsWith("../"))
      return false;
    return workspaceContains({
      directory: root,
      file: path.posix.join(directory, "package.json"),
      patterns,
      rootMembership: "patterns",
    });
  };
  const installable = new Set(["."]);
  if (ecosystem === "npm") {
    for (const file of manifests) {
      const directory = path.posix.dirname(file);
      if (
        declaresJavascriptInstallation(
          files[path.posix.join(directory, "package.json")],
        ) ||
        javascriptDependencyLockfiles.some(
          (name) => files[path.posix.join(directory, name)] !== undefined,
        )
      )
        installable.add(directory);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const [root, patterns] of workspaces) {
        if (!installable.has(root)) {
          if (
            ![...installable].some((directory) =>
              declaredMember(root, patterns, directory),
            )
          )
            continue;
          installable.add(root);
          changed = true;
        }
        for (const file of manifests) {
          const directory = path.posix.dirname(file);
          if (
            installable.has(directory) ||
            !declaredMember(root, patterns, directory)
          )
            continue;
          installable.add(directory);
          changed = true;
        }
      }
    }
  }
  if (ecosystem === "npm") {
    for (const [directory, error] of npmWorkspaceErrors)
      if (installable.has(directory)) throw error;
  }
  if (ecosystem === "cargo") {
    for (const [root, patterns] of workspaces) {
      const includes = patterns.filter((pattern) => !pattern.startsWith("!"));
      const excludes = patterns.filter((pattern) => pattern.startsWith("!"));
      const memberDirectories = new Set([root]);
      for (const file of manifests) {
        const directory = path.posix.dirname(file);
        const relative = path.posix.relative(root, directory);
        if (
          includes.some((pattern) => picomatch.isMatch(relative, pattern)) &&
          !excludes.some((pattern) =>
            picomatch.isMatch(relative, pattern.slice(1)),
          )
        )
          memberDirectories.add(directory);
      }
      for (const directory of memberDirectories) {
        try {
          const parsed = parseToml(
            files[path.posix.join(directory, "Cargo.toml")] ?? "",
          );
          const rootParsed = parseToml(
            files[path.posix.join(root, "Cargo.toml")] ?? "",
          );
          const workspace = rootParsed["workspace"];
          const inherited = record(workspace)
            ? workspace["dependencies"]
            : undefined;
          const dependencyOwners = [parsed];
          const targets = parsed["target"];
          if (record(targets)) {
            for (const target of Object.values(targets))
              if (record(target)) dependencyOwners.push(target);
          }
          for (const owner of dependencyOwners) {
            for (const key of [
              "dependencies",
              "dev-dependencies",
              "build-dependencies",
            ]) {
              const dependencies = owner[key];
              if (!record(dependencies)) continue;
              for (const [name, dependency] of Object.entries(dependencies)) {
                if (!record(dependency)) continue;
                const isInherited = dependency["workspace"] === true;
                const resolved =
                  isInherited && record(inherited)
                    ? inherited[name]
                    : dependency;
                if (!record(resolved) || typeof resolved["path"] !== "string")
                  continue;
                if (
                  path.posix.isAbsolute(resolved["path"]) ||
                  /\\|\$|^[A-Za-z]:/.test(resolved["path"])
                )
                  continue;
                const target = path.posix.normalize(
                  path.posix.join(
                    isInherited ? root : directory,
                    resolved["path"],
                  ),
                );
                const relative = path.posix.relative(root, target);
                if (
                  relative.startsWith("../") ||
                  relative === ".." ||
                  files[path.posix.join(target, "Cargo.toml")] === undefined ||
                  excludes.some((pattern) =>
                    picomatch.isMatch(relative, pattern.slice(1)),
                  )
                )
                  continue;
                memberDirectories.add(target);
              }
            }
          }
        } catch {
          // Manifest validation diagnoses malformed TOML independently.
        }
      }
      implicitCargoMembers.set(root, memberDirectories);
    }
  }
  return manifests
    .filter(
      (file) =>
        ecosystem !== "npm" || installable.has(path.posix.dirname(file)),
    )
    .filter((file) => {
      const directory = path.posix.dirname(file);
      return ![...workspaces].some(([root, patterns]) => {
        if (ecosystem === "npm" && !installable.has(root)) return false;
        const relative = path.posix.relative(root, directory);
        if (relative === "" || relative.startsWith("../")) return false;
        const includes = patterns.filter((pattern) => !pattern.startsWith("!"));
        const excludes = patterns.filter((pattern) => pattern.startsWith("!"));
        return (
          (implicitCargoMembers.get(root)?.has(directory) === true ||
            (ecosystem === "npm"
              ? declaredMember(root, patterns, directory)
              : includes.some((pattern) =>
                  picomatch.isMatch(relative, pattern),
                ))) &&
          !excludes.some((pattern) =>
            picomatch.isMatch(relative, pattern.slice(1)),
          )
        );
      });
    })
    .map(directoryOf)
    .filter((directory, index, values) => values.indexOf(directory) === index);
};

type CheckDependabotOptions = {
  files: Record<string, string>;
  policy: DependabotPolicy;
  /** Parsed stll-toolchain.json `dependabotIgnores`. */
  ignores?: readonly DependabotIgnoreDeclaration[] | undefined;
};

const javascriptEcosystem = (
  directory: string,
  files: Record<string, string>,
) => {
  let root = directory === "/" ? "." : directory.slice(1);
  for (;;) {
    if (files[path.posix.join(root, "bun.lock")] !== undefined) return "bun";
    try {
      const manifest: unknown = JSON.parse(
        files[path.posix.join(root, "package.json")] ?? "{}",
      );
      if (record(manifest) && typeof manifest["packageManager"] === "string")
        return manifest["packageManager"].startsWith("bun@") ? "bun" : "npm";
    } catch {
      // Package rules diagnose malformed JSON; retain its update coverage.
    }
    for (const name of javascriptDependencyLockfiles)
      if (files[path.posix.join(root, name)] !== undefined) return "npm";
    if (root === ".") return "npm";
    root = path.posix.dirname(root);
  }
};

const pythonEcosystem = (file: string, files: Record<string, string>) => {
  const manifestKind = pythonDependencyManifestKind(file);
  if (
    manifestKind === "pipfile" ||
    manifestKind === "pipfile-lock" ||
    manifestKind === "setup"
  )
    return "pip";
  const root = path.posix.dirname(file);
  if (
    files[path.posix.join(root, "uv.lock")] !== undefined ||
    files[path.posix.join(root, "uv.toml")] !== undefined
  )
    return "uv";
  const pyproject = files[path.posix.join(root, "pyproject.toml")];
  if (pyproject !== undefined) {
    try {
      const parsed = parseToml(pyproject);
      const tool = parsed["tool"];
      if (record(tool) && record(tool["uv"])) return "uv";
    } catch {
      // Runtime rules diagnose malformed TOML; retain its update coverage.
    }
  }
  return "pip";
};

const ecosystemRoots = (files: Record<string, string>) => {
  const roots = new Map<string, Set<string>>();
  const requireRoot = (ecosystem: string, directory: string) => {
    const directories = roots.get(ecosystem) ?? new Set<string>();
    directories.add(directory);
    roots.set(ecosystem, directories);
  };
  for (const directory of workspaceRoots(files, "npm"))
    requireRoot(javascriptEcosystem(directory, files), directory);
  for (const directory of workspaceRoots(files, "cargo"))
    requireRoot("cargo", directory);
  for (const directory of workspaceRoots(files, "uv")) {
    const root = directory === "/" ? "." : directory.slice(1);
    requireRoot(
      pythonEcosystem(path.posix.join(root, "pyproject.toml"), files),
      directory,
    );
  }
  for (const file of Object.keys(files)) {
    if (isDependabotGithubActionsPath(file)) requireRoot("github-actions", "/");
    const name = path.posix.basename(file);
    const manifestEcosystem = dependabotManifestEcosystem(file);
    if (manifestEcosystem !== undefined)
      requireRoot(manifestEcosystem, directoryOf(file));
    if (isDockerDefinitionPath(file)) requireRoot("docker", directoryOf(file));
    if (isComposeDefinitionPath(file) || isKubernetesDefinitionPath(file)) {
      for (const document of parseAllDocuments(files[file] ?? "", {
        merge: true,
      })) {
        if (document.errors.length > 0) continue;
        try {
          const classified = containerDocumentImages(
            document.toJS({ maxAliasCount: 100 }),
            file,
          );
          if (classified !== undefined)
            requireRoot(classified.ecosystem, directoryOf(file));
        } catch {
          // Runtime validation reports malformed or excessive YAML aliases.
        }
      }
    }
    if (
      name === "uv.lock" ||
      name === "uv.toml" ||
      (name !== "pyproject.toml" && isPythonDependencyManifest(file))
    )
      requireRoot(pythonEcosystem(file, files), directoryOf(file));
  }
  return roots;
};

const ignoredFor = (ecosystem: string, policy: DependabotPolicy) => {
  if (ecosystem === "npm" || ecosystem === "bun") return policy.ignoredPackages;
  if (ecosystem === "github-actions") return policy.ignoredActions;
  if (ecosystem === "docker" || ecosystem === "docker-compose")
    return ownedDockerImageAliases(policy.ignoredImages);
  return [];
};

type DeclaredIgnoreConflictsOptions = {
  ignores: readonly DependabotIgnoreDeclaration[];
  policy: DependabotPolicy;
};

/** Shared pins stay owned by the shared policy; declarations cannot name or match them. */
export const declaredIgnoreConflicts = ({
  ignores,
  policy,
}: DeclaredIgnoreConflictsOptions) =>
  ignores.flatMap(({ ecosystem, dependency }) => {
    const pattern = dependencyPattern(dependency);
    return ignoredFor(ecosystem, policy)
      .filter((pin) => pattern.test(pin))
      .map(
        (pin) =>
          `Dependabot ignore ${ecosystem} ${dependency} covers shared pin ${pin}; the shared policy owns its ignore`,
      );
  });

/** Repository declarations own coverage only; shared policy owns every update option. */
export const parseDependabotInput = (input: unknown) => {
  if (
    !record(input) ||
    Object.keys(input).some((key) => key !== "updates") ||
    !Array.isArray(input["updates"]) ||
    input["updates"].length === 0
  )
    throw new Error(
      "Dependabot input must contain a nonempty updates array only",
    );
  const ecosystems = new Set<string>();
  return input["updates"].map((entry: unknown) => {
    if (
      !record(entry) ||
      Object.keys(entry).some(
        (key) => !["ecosystem", "directories"].includes(key),
      ) ||
      typeof entry["ecosystem"] !== "string" ||
      !strings(entry["directories"]) ||
      entry["directories"].length === 0
    )
      throw new Error(
        "each Dependabot update must contain ecosystem and nonempty directories only",
      );
    const ecosystem = entry["ecosystem"];
    if (!isDependabotEcosystem(ecosystem))
      throw new Error(`unsupported Dependabot ecosystem: ${ecosystem}`);
    const directories = entry["directories"];
    if (ecosystems.has(ecosystem))
      throw new Error(`duplicate Dependabot ecosystem: ${ecosystem}`);
    ecosystems.add(ecosystem);
    const seen = new Set<string>();
    for (const directory of directories) {
      if (
        !directory.startsWith("/") ||
        directory.includes("\\") ||
        directory.split("/").some((part) => part === "." || part === "..") ||
        path.posix.normalize(directory) !== directory ||
        (directory !== "/" && directory.endsWith("/")) ||
        /[*?[\]{}!]/.test(directory)
      )
        throw new Error(
          `Dependabot directory must be a literal absolute repository path: ${directory}`,
        );
      if (seen.has(directory))
        throw new Error(`duplicate Dependabot directory: ${directory}`);
      seen.add(directory);
    }
    return { ecosystem, directories };
  });
};

type GenerateDependabotOptions = CheckDependabotOptions & {
  updates?: ReturnType<typeof parseDependabotInput> | undefined;
};

/** Generate canonical YAML from the same ecosystem enumeration used by the guard. */
export const generateDependabotConfig = ({
  files,
  policy,
  updates: declarations,
  ignores = [],
}: GenerateDependabotOptions) => {
  const conflicts = declaredIgnoreConflicts({ ignores, policy });
  if (conflicts.length > 0) throw new Error(conflicts.join("\n"));
  const detected = ecosystemRoots(files);
  const roots =
    declarations === undefined
      ? detected
      : new Map(
          parseDependabotInput({ updates: declarations }).map(
            ({ ecosystem, directories }) => [ecosystem, new Set(directories)],
          ),
        );
  for (const [ecosystem, directories] of detected) {
    for (const directory of directories) {
      if (!roots.get(ecosystem)?.has(directory))
        throw new Error(
          `Dependabot input must cover ${ecosystem} directory ${directory}`,
        );
    }
  }
  for (const { ecosystem, dependency } of ignores)
    if (!roots.has(ecosystem))
      throw new Error(
        `Dependabot ignore ${ecosystem} ${dependency} has no ${ecosystem} update entry`,
      );
  const updates = [...roots]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ecosystem, ecosystemDirectories]) => {
      const directories = [...ecosystemDirectories].sort();
      const ignore = [
        ...ignoredFor(ecosystem, policy).map((name) => ({
          "dependency-name": name,
          "update-types": dependabotIgnoreUpdateTypes,
        })),
        ...ignores
          .filter((declared) => declared.ecosystem === ecosystem)
          .sort(byDependency)
          .map(({ dependency, updateTypes }) => ({
            "dependency-name": dependency,
            "update-types": updateTypes,
          })),
      ];
      const time = new Scalar(policy.schedule.time);
      time.type = Scalar.QUOTE_DOUBLE;
      return {
        "package-ecosystem": ecosystem,
        directory: directories.length === 1 ? directories.at(0) : undefined,
        directories: directories.length > 1 ? directories : undefined,
        schedule: {
          interval: policy.schedule.interval,
          day: policy.schedule.day,
          time,
          timezone: policy.schedule.timezone,
        },
        cooldown: { "default-days": policy.cooldown.defaultDays },
        groups: Object.fromEntries(
          groupsFor({ ecosystem, policy, files }).map(([name, group]) => [
            name,
            {
              patterns: group.patterns,
              "update-types": group.updateTypes,
              "exclude-patterns": group.excludePatterns,
            },
          ]),
        ),
        ignore: ignore.length > 0 ? ignore : undefined,
      };
    });
  return stringify({ version: 2, updates }, { aliasDuplicateObjects: false });
};

/** Validate the shared update policy against a hermetic tracked-file snapshot. */
export const checkDependabot = ({
  files,
  policy,
  ignores = [],
}: CheckDependabotOptions): Diagnostic[] => {
  const roots = ecosystemRoots(files);
  const paths = [".github/dependabot.yml", ".github/dependabot.yaml"].filter(
    (file) => files[file] !== undefined,
  );
  if (roots.size === 0 && paths.length === 0 && ignores.length === 0) return [];
  const file = paths.at(0) ?? ".github/dependabot.yml";
  const diagnostics: Diagnostic[] = [];
  const add = (message: string, line = 1) => {
    diagnostics.push({ rule: "dependabot-policy", path: file, line, message });
  };
  if (paths.length === 0) {
    add(
      "add a Dependabot configuration for the repository's package ecosystems",
    );
    return diagnostics;
  }
  if (paths.length > 1) add("keep one Dependabot configuration file");
  const lineCounter = new LineCounter();
  const document = parseDocument(files[file] ?? "", {
    lineCounter,
  });
  if (document.errors.length > 0) {
    for (const error of document.errors)
      add(
        `invalid Dependabot YAML: ${error.message}`,
        lineCounter.linePos(error.pos[0]).line,
      );
    return diagnostics;
  }
  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 100 });
  } catch {
    add("cannot resolve Dependabot YAML aliases");
    return diagnostics;
  }
  if (
    !record(parsed) ||
    parsed["version"] !== 2 ||
    !Array.isArray(parsed["updates"])
  ) {
    add("Dependabot must declare version: 2 and an updates array");
    return diagnostics;
  }
  const covered = new Map<string, Set<string>>();
  let legacy: unknown;
  try {
    const legacyDocument = parseDocument(files[file] ?? "", {
      version: "1.1",
      schema: "yaml-1.1",
    });
    if (legacyDocument.errors.length === 0)
      legacy = legacyDocument.toJS({ maxAliasCount: 100 });
  } catch {
    // The canonical parser reports invalid aliases; incompatible times fail below.
  }
  const legacyUpdates =
    record(legacy) && Array.isArray(legacy["updates"]) ? legacy["updates"] : [];
  const rootClaims = new Map<string, Map<string, number>>();
  const updatedEcosystems = new Set<string>();
  const directoryClaims = new Map<string, Map<string, number>>();
  for (const [index, update] of parsed["updates"].entries()) {
    const lineOf = (key: string) => {
      const node: unknown = document.getIn(["updates", index, key], true);
      const offset = isNode(node) ? node.range?.[0] : undefined;
      return offset === undefined ? 1 : lineCounter.linePos(offset).line;
    };
    const report = (key: string, message: string) => add(message, lineOf(key));
    if (!record(update) || typeof update["package-ecosystem"] !== "string") {
      report(
        "package-ecosystem",
        "each Dependabot update must declare a package ecosystem",
      );
      continue;
    }
    const ecosystem = update["package-ecosystem"];
    if (update["target-branch"] !== undefined)
      report(
        "target-branch",
        `${ecosystem}: shared updates must target the default branch`,
      );
    if (update["open-pull-requests-limit"] === 0)
      report(
        "open-pull-requests-limit",
        `${ecosystem}: version updates must remain enabled`,
      );
    const single = update["directory"];
    const multiple = update["directories"];
    let directories: string[] = [];
    if (typeof single === "string" && multiple === undefined)
      directories = [single];
    else if (single === undefined && strings(multiple)) directories = multiple;
    const validDirectories = directories.filter(
      (directory) =>
        directory.startsWith("/") && !directory.split("/").includes(".."),
    );
    if (
      directories.length === 0 ||
      validDirectories.length !== directories.length
    ) {
      report(
        "directory",
        `${ecosystem}: declare directory or nonempty directories with absolute repository paths`,
      );
    }
    const normalizedDirectories = Array.from(
      new Set(
        validDirectories.map(
          (value) => path.posix.normalize(value).replace(/\/+$/, "") || "/",
        ),
      ),
    );
    const matches = covered.get(ecosystem) ?? new Set<string>();
    const claimedDirectories =
      directoryClaims.get(ecosystem) ?? new Map<string, number>();
    for (const directory of normalizedDirectories) {
      const previous = claimedDirectories.get(directory);
      if (previous !== undefined)
        report(
          multiple === undefined ? "directory" : "directories",
          `${ecosystem}: directory ${directory} overlaps update entry ${previous + 1}`,
        );
      else claimedDirectories.set(directory, index);
    }
    directoryClaims.set(ecosystem, claimedDirectories);
    const claimedRoots = rootClaims.get(ecosystem) ?? new Map<string, number>();
    for (const root of roots.get(ecosystem) ?? []) {
      if (
        normalizedDirectories.some(
          (directory) =>
            directory === root ||
            (multiple !== undefined && picomatch.isMatch(root, directory)),
        )
      ) {
        const previous = claimedRoots.get(root);
        if (previous !== undefined)
          report(
            multiple === undefined ? "directory" : "directories",
            `${ecosystem}: update root ${root} overlaps update entry ${previous + 1}`,
          );
        else claimedRoots.set(root, index);
        matches.add(root);
      }
    }
    rootClaims.set(ecosystem, claimedRoots);
    covered.set(ecosystem, matches);
    const schedule = update["schedule"];
    const legacyUpdate: unknown = legacyUpdates.at(index);
    const legacySchedule = record(legacyUpdate)
      ? legacyUpdate["schedule"]
      : undefined;
    if (
      record(schedule) &&
      schedule["time"] === policy.schedule.time &&
      (!record(legacySchedule) ||
        legacySchedule["time"] !== policy.schedule.time)
    )
      report(
        "schedule",
        `${ecosystem}: quote schedule time to preserve its string value in YAML 1.1`,
      );
    if (
      !record(schedule) ||
      Object.keys(schedule).length !== Object.keys(policy.schedule).length ||
      Object.entries(policy.schedule).some(
        ([key, value]) => schedule[key] !== value,
      )
    )
      report("schedule", `${ecosystem}: schedule must match the shared policy`);
    const cooldown = update["cooldown"];
    if (
      !record(cooldown) ||
      Object.keys(cooldown).length !== 1 ||
      cooldown["default-days"] !== policy.cooldown.defaultDays
    )
      report(
        "cooldown",
        `${ecosystem}: cooldown must contain only default-days: ${policy.cooldown.defaultDays}`,
      );
    const groups = update["groups"];
    const expectedGroups = groupsFor({ ecosystem, policy, files });
    if (
      !record(groups) ||
      // Dependabot assigns an update to the first matching group.
      JSON.stringify(Object.keys(groups)) !==
        JSON.stringify(expectedGroups.map(([name]) => name)) ||
      expectedGroups.some(([name, expected]) => {
        const group = groups[name];
        return (
          !record(group) ||
          Object.keys(group).length !==
            1 +
              Number(expected.updateTypes !== undefined) +
              Number(expected.excludePatterns !== undefined) ||
          !sameStrings(group["patterns"], expected.patterns) ||
          (expected.excludePatterns !== undefined &&
            !sameStrings(
              group["exclude-patterns"],
              expected.excludePatterns,
            )) ||
          (expected.updateTypes !== undefined &&
            !sameStrings(group["update-types"], expected.updateTypes))
        );
      })
    )
      report("groups", `${ecosystem}: groups must match the shared policy`);
    const ignored = ignoredFor(ecosystem, policy);
    const declared = ignores.filter(
      (declaration) => declaration.ecosystem === ecosystem,
    );
    updatedEcosystems.add(ecosystem);
    const ignore = update["ignore"];
    if (ignore !== undefined && (!Array.isArray(ignore) || ignore.length === 0))
      report("ignore", `${ecosystem}: omit ignore or provide a nonempty array`);
    const entries: unknown[] = Array.isArray(ignore) ? ignore : [];
    const nameOf = (entry: unknown) =>
      record(entry) && typeof entry["dependency-name"] === "string"
        ? entry["dependency-name"]
        : undefined;
    if (
      entries.some((entry) => {
        const name = nameOf(entry);
        return (
          name === undefined ||
          (!ignored.includes(name) &&
            !declared.some(({ dependency }) => dependency === name))
        );
      })
    )
      report(
        "ignore",
        `${ecosystem}: ignore only packages owned by the shared policy or declared in stll-toolchain.json dependabotIgnores`,
      );
    if (
      entries.some((entry) => {
        const name = nameOf(entry);
        return (
          name !== undefined &&
          ignored.includes(name) &&
          !versionOnlyIgnore(entry)
        );
      })
    )
      report(
        "ignore",
        `${ecosystem}: each shared-pin ignore must contain only dependency-name and update-types for semver-major, semver-minor, and semver-patch version updates; security updates must remain enabled`,
      );
    for (const name of ignored) {
      if (
        !entries.some(
          (entry) => nameOf(entry) === name && versionOnlyIgnore(entry),
        )
      )
        report(
          "ignore",
          `${ecosystem}: ignore all version updates for shared pin ${name}`,
        );
    }
    for (const { dependency, updateTypes } of declared) {
      const matching = entries.filter((entry) => nameOf(entry) === dependency);
      if (
        matching.length !== 1 ||
        !matching.every((entry) => versionIgnore(entry, updateTypes))
      )
        report(
          "ignore",
          `${ecosystem}: ignore ${dependency} exactly once with only update-types ${updateTypes.join(", ")} as declared in stll-toolchain.json`,
        );
    }
  }
  for (const { ecosystem, dependency } of ignores)
    if (!updatedEcosystems.has(ecosystem))
      add(
        `Dependabot ignore ${ecosystem} ${dependency} has no ${ecosystem} update entry`,
      );
  for (const [ecosystem, directories] of roots) {
    for (const directory of directories) {
      if (!covered.get(ecosystem)?.has(directory))
        add(`add a ${ecosystem} update entry covering ${directory}`);
    }
  }
  return diagnostics;
};
