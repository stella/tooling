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
  isDependabotGithubActionsPath,
  isDockerDefinitionPath,
  pythonDependencyManifestKind,
  isPythonDependencyManifest,
  javascriptDependencyLockfiles,
} from "./toolchain-inputs";
import { workspaceContains } from "./toolchain-workspaces";

export const dependabotRules = ["dependabot-policy"] as const;

type DependabotPolicy = {
  schedule: { interval: string; day: string; time: string; timezone: string };
  cooldown: { defaultDays: number };
  groups: Record<
    string,
    { patterns: readonly string[]; updateTypes: readonly string[] }
  >;
  ignoredPackages: readonly string[];
  ignoredActions: readonly string[];
  ignoredImages: readonly string[];
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

/** Installable workspace members share their update root; own-lock projects stay discoverable. */
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
        if (!installable.has(root)) continue;
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
};

const javascriptEcosystem = (
  directory: string,
  files: Record<string, string>,
) => {
  const root = directory === "/" ? "." : directory.slice(1);
  if (files[path.posix.join(root, "bun.lock")] !== undefined) return "bun";
  try {
    const manifest: unknown = JSON.parse(
      files[path.posix.join(root, "package.json")] ?? "{}",
    );
    if (
      record(manifest) &&
      typeof manifest["packageManager"] === "string" &&
      manifest["packageManager"].startsWith("bun@")
    )
      return "bun";
  } catch {
    // Package rules diagnose malformed JSON; the root still needs update coverage.
  }
  return "npm";
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

/** Generate canonical YAML from the same ecosystem enumeration used by the guard. */
export const generateDependabotConfig = ({
  files,
  policy,
}: CheckDependabotOptions) => {
  const updates = [...ecosystemRoots(files)]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ecosystem, roots]) => {
      const directories = [...roots].sort();
      const ignored = ignoredFor(ecosystem, policy);
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
          Object.entries(policy.groups).map(([name, group]) => [
            name,
            { patterns: group.patterns, "update-types": group.updateTypes },
          ]),
        ),
        ignore:
          ignored.length > 0
            ? ignored.map((name) => ({ "dependency-name": name }))
            : undefined,
      };
    });
  return stringify({ version: 2, updates }, { aliasDuplicateObjects: false });
};

/** Validate the shared update policy against a hermetic tracked-file snapshot. */
export const checkDependabot = ({
  files,
  policy,
}: CheckDependabotOptions): Diagnostic[] => {
  const roots = ecosystemRoots(files);
  const paths = [".github/dependabot.yml", ".github/dependabot.yaml"].filter(
    (file) => files[file] !== undefined,
  );
  if (roots.size === 0 && paths.length === 0) return [];
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
    if (
      !record(groups) ||
      Object.keys(groups).length !== Object.keys(policy.groups).length ||
      Object.entries(policy.groups).some(([name, expected]) => {
        const group = groups[name];
        return (
          !record(group) ||
          Object.keys(group).length !== 2 ||
          !sameStrings(group["patterns"], expected.patterns) ||
          !sameStrings(group["update-types"], expected.updateTypes)
        );
      })
    )
      report("groups", `${ecosystem}: groups must match the shared policy`);
    const ignored = ignoredFor(ecosystem, policy);
    const ignore = update["ignore"];
    if (ignore !== undefined && (!Array.isArray(ignore) || ignore.length === 0))
      report("ignore", `${ecosystem}: omit ignore or provide a nonempty array`);
    if (
      Array.isArray(ignore) &&
      ignore.some(
        (entry: unknown) =>
          !record(entry) ||
          typeof entry["dependency-name"] !== "string" ||
          !ignored.includes(entry["dependency-name"]),
      )
    )
      report(
        "ignore",
        `${ecosystem}: ignore only packages owned by the shared policy`,
      );
    for (const name of ignored) {
      if (
        !Array.isArray(ignore) ||
        !ignore.some(
          (entry: unknown) =>
            record(entry) &&
            entry["dependency-name"] === name &&
            Object.keys(entry).length === 1,
        )
      )
        report(
          "ignore",
          `${ecosystem}: ignore all updates for shared pin ${name}`,
        );
    }
  }
  for (const [ecosystem, directories] of roots) {
    for (const directory of directories) {
      if (!covered.get(ecosystem)?.has(directory))
        add(`add a ${ecosystem} update entry covering ${directory}`);
    }
  }
  return diagnostics;
};
