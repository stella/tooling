import path from "node:path";
import picomatch from "picomatch";
import { compare, satisfies, validRange } from "semver";
import { parseDocument } from "yaml";

export const consumerFixtureKinds = ["node", "react"] as const;
export type ConsumerFixture = {
  package: string;
  fixture: string;
  kind: (typeof consumerFixtureKinds)[number];
  build: string[];
  smoke: string[];
};

export const consumerRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const consumerRelativePath = (value: unknown, field: string) => {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((part) => part === ".." || part === "")
  )
    throw new Error(`${field} must be a repository-relative path`);
  return path.posix.normalize(value);
};

const command = (value: unknown, field: string) => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (part: unknown) =>
        typeof part === "string" && part !== "" && !part.includes("\0"),
    )
  )
    throw new Error(`${field} must be a nonempty command argument array`);
  return value.map((part: string) => part);
};

export const parseConsumerFixtures = (input: unknown): ConsumerFixture[] => {
  if (
    !consumerRecord(input) ||
    Object.keys(input).some((key) => key !== "packages") ||
    !Array.isArray(input["packages"])
  )
    throw new Error("consumer fixtures must contain only a packages array");
  const seen = new Set<string>();
  return input["packages"].map((entry: unknown) => {
    if (
      !consumerRecord(entry) ||
      Object.keys(entry).some(
        (key) =>
          !["package", "fixture", "kind", "build", "smoke"].includes(key),
      )
    )
      throw new Error("invalid consumer fixture declaration");
    const packagePath = consumerRelativePath(entry["package"], "package");
    const fixture = consumerRelativePath(entry["fixture"], "fixture");
    const kind = entry["kind"];
    if (kind !== "node" && kind !== "react")
      throw new Error("fixture kind must be node or react");
    if (seen.has(packagePath))
      throw new Error(`duplicate consumer fixture: ${packagePath}`);
    seen.add(packagePath);
    return {
      package: packagePath,
      fixture,
      kind,
      build: command(entry["build"], "build"),
      smoke: command(entry["smoke"], "smoke"),
    };
  });
};

export type ConsumerPackage = {
  directory: string;
  name: string;
  manifest: Record<string, unknown>;
};

export const consumerStagingPaths = (
  packages: Map<string, ConsumerPackage>,
) => {
  const paths = new Map<string, string>();
  for (const [name, pkg] of packages)
    paths.set(
      name,
      consumerRelativePath(pkg.directory, "workspace package directory"),
    );
  return paths;
};

export const consumerPackRootManifest = (
  packages: Map<string, ConsumerPackage>,
) => {
  const root = [...packages.values()].find((pkg) => pkg.directory === ".");
  return root?.manifest ?? { private: true };
};

export const consumerDependencyConfigFiles = [
  ".npmrc",
  ".pnpmfile.cjs",
  "pnpm-workspace.yaml",
  ".yarnrc",
  ".yarnrc.yml",
] as const;

export const assertConsumerFixtureManifest = (
  manifest: Record<string, unknown>,
) => {
  for (const field of [
    "pnpm",
    "overrides",
    "resolutions",
    "workspaces",
    "packageManager",
  ])
    if (manifest[field] !== undefined)
      throw new Error(
        `consumer fixture must not supply dependency-manager setting: ${field}`,
      );
};

type BindConsumerManifestOptions = {
  manifest: Record<string, unknown>;
  artifacts: Map<string, string>;
  typescript: string;
  react: Record<string, string>;
  manager: "npm" | "pnpm";
};
export const bindConsumerManifest = ({
  manifest,
  artifacts,
  typescript,
  react,
  manager,
}: BindConsumerManifestOptions) => {
  assertConsumerFixtureManifest(manifest);
  const artifactBindings = Object.fromEntries(
    [...artifacts].map(([name, file]) => [name, `file:${file}`]),
  );
  const owned = { ...artifactBindings, typescript, ...react };
  const result = { ...manifest };
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const entries = manifest[field];
    if (entries === undefined) continue;
    if (!consumerRecord(entries))
      throw new Error(`fixture ${field} must be an object`);
    for (const specifier of Object.values(entries))
      if (
        typeof specifier !== "string" ||
        /^(?:workspace:|file:|link:|\.\.?\/|\/)/.test(specifier)
      )
        throw new Error(
          "fixture dependencies must resolve from registry or generated artifact bindings",
        );
    result[field] = Object.fromEntries(
      Object.entries(entries).filter(([name]) => !(name in owned)),
    );
  }
  result["dependencies"] = {
    ...(consumerRecord(result["dependencies"]) ? result["dependencies"] : {}),
    ...artifactBindings,
    ...react,
  };
  result["devDependencies"] = {
    ...(consumerRecord(result["devDependencies"])
      ? result["devDependencies"]
      : {}),
    typescript,
  };
  if (manager === "npm") {
    result["overrides"] = owned;
    return { manager, manifest: result };
  }
  return {
    manager,
    manifest: result,
    workspace: { packages: ["."], overrides: owned },
  };
};

const workspacePatterns = (manifest: Record<string, unknown>) => {
  const workspace = manifest["workspaces"];
  const patterns = consumerRecord(workspace)
    ? workspace["packages"]
    : workspace;
  if (patterns === undefined) return [];
  if (
    !Array.isArray(patterns) ||
    !patterns.every((entry: unknown) => typeof entry === "string")
  )
    throw new Error("package workspaces must be string patterns");
  return patterns.map((entry: string) => entry);
};

export const discoverConsumerManifests = (files: Record<string, string>) => {
  const manifests = new Map<string, Record<string, unknown>>();
  const manifestSources = new Map<string, string>();
  const pnpmSources = new Map<string, string>();
  const pnpmWorkspaces = new Map<string, string[]>();
  for (const [file, content] of Object.entries(files)) {
    if (path.posix.basename(file) === "pnpm-workspace.yaml") {
      pnpmSources.set(path.posix.dirname(file), content);
    } else if (path.posix.basename(file) === "package.json")
      manifestSources.set(path.posix.dirname(file), content);
  }
  const manifestAt = (directory: string) => {
    const cached = manifests.get(directory);
    if (cached) return cached;
    const source = manifestSources.get(directory);
    if (source === undefined) return undefined;
    const json: unknown = JSON.parse(source);
    if (!consumerRecord(json))
      throw new Error(`invalid package manifest: ${directory}/package.json`);
    manifests.set(directory, json);
    return json;
  };
  const patternsAt = (
    directory: string,
    manifest: Record<string, unknown> | undefined,
  ) => {
    const source = pnpmSources.get(directory);
    if (source !== undefined && !pnpmWorkspaces.has(directory)) {
      const file = `${directory}/pnpm-workspace.yaml`;
      const document = parseDocument(source, { uniqueKeys: true });
      if (document.errors.length)
        throw new Error(`invalid pnpm workspace: ${file}`);
      const json: unknown = document.toJS({ maxAliasCount: 100 });
      if (!consumerRecord(json))
        throw new Error(`invalid pnpm workspace: ${file}`);
      const patterns = json["packages"] ?? [];
      if (
        !Array.isArray(patterns) ||
        !patterns.every((entry: unknown) => typeof entry === "string")
      )
        throw new Error(`invalid pnpm workspace packages: ${file}`);
      pnpmWorkspaces.set(
        directory,
        patterns.map((entry: string) => entry),
      );
    }
    return pnpmWorkspaces.get(directory) ?? workspacePatterns(manifest ?? {});
  };
  const roots = new Set(["."]);
  for (;;) {
    const before = roots.size;
    for (const directory of roots) {
      const manifest = manifestAt(directory);
      const patterns = patternsAt(directory, manifest);
      for (const candidate of manifestSources.keys()) {
        const relative = path.posix.relative(directory, candidate);
        if (relative === "" || relative.startsWith("../")) continue;
        const positives = patterns.filter(
          (pattern) => !pattern.startsWith("!"),
        );
        const negatives = patterns
          .filter((pattern) => pattern.startsWith("!"))
          .map((pattern) => pattern.slice(1));
        if (
          positives.some((pattern) => picomatch.isMatch(relative, pattern)) &&
          !negatives.some((pattern) => picomatch.isMatch(relative, pattern))
        )
          roots.add(candidate);
      }
    }
    if (before === roots.size) break;
  }
  const discovered = new Map<string, Record<string, unknown>>();
  for (const directory of roots) {
    const manifest = manifestAt(directory);
    if (manifest) discovered.set(directory, manifest);
  }
  return discovered;
};

export const discoverConsumerPackages = (files: Record<string, string>) => {
  const packages = new Map<string, ConsumerPackage>();
  for (const [directory, manifest] of discoverConsumerManifests(files)) {
    const name = manifest["name"];
    if (typeof name !== "string" || name === "") continue;
    if (packages.has(name))
      throw new Error(`duplicate workspace package: ${name}`);
    packages.set(name, { directory, name, manifest });
  }
  return packages;
};

export const consumerPackageClosure = (
  selected: ConsumerPackage,
  packages: Map<string, ConsumerPackage>,
) => {
  const closure = new Map<string, ConsumerPackage>();
  const visit = (pkg: ConsumerPackage) => {
    if (closure.has(pkg.name)) return;
    closure.set(pkg.name, pkg);
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const dependencies = pkg.manifest[field];
      if (!consumerRecord(dependencies)) continue;
      for (const [name, specifier] of Object.entries(dependencies)) {
        const local = packages.get(name);
        if (typeof specifier !== "string")
          throw new Error(`invalid package dependency: ${pkg.name} -> ${name}`);
        if (/^(?:file:|link:)/.test(specifier))
          throw new Error(
            `published local dependencies must use workspace protocol: ${pkg.name} -> ${name}`,
          );
        if (
          local &&
          (specifier.startsWith("workspace:") ||
            (typeof local.manifest["version"] === "string" &&
              validRange(specifier) &&
              satisfies(local.manifest["version"], specifier)))
        ) {
          if (local.manifest["private"] === true)
            throw new Error(
              `published package depends on private workspace package: ${pkg.name} -> ${name}`,
            );
          visit(local);
        } else if (
          typeof specifier === "string" &&
          specifier.startsWith("workspace:")
        )
          throw new Error(
            `unresolved workspace dependency: ${pkg.name} -> ${name}`,
          );
      }
    }
  };
  visit(selected);
  return closure;
};

export const oldestPublishedConsumerVersion = (
  versions: readonly string[],
  range: string,
) => {
  if (!validRange(range))
    throw new Error(`invalid consumer peer range: ${range}`);
  const candidates = versions
    .filter((version) => satisfies(version, range))
    .sort(compare);
  const version = candidates.at(0);
  if (!version)
    throw new Error(`no published consumer version satisfies ${range}`);
  return version;
};
