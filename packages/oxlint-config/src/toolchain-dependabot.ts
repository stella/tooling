import path from "node:path";
import picomatch from "picomatch";
import { parse as parseToml } from "smol-toml";
import { isNode, LineCounter, parseDocument, stringify } from "yaml";

import { ownedDockerImageAliases } from "./toolchain-images";

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

/** Workspace members share their update root; independent manifests keep their own. */
const workspaceRoots = (
  files: Record<string, string>,
  ecosystem: "npm" | "cargo",
) => {
  const manifests = Object.keys(files).filter(
    (file) =>
      path.posix.basename(file) ===
      (ecosystem === "npm" ? "package.json" : "Cargo.toml"),
  );
  const workspaces = new Map<string, string[]>();
  for (const file of manifests) {
    try {
      const parsed: unknown =
        ecosystem === "npm"
          ? JSON.parse(files[file] ?? "")
          : parseToml(files[file] ?? "");
      if (!record(parsed)) continue;
      const value = parsed[ecosystem === "npm" ? "workspaces" : "workspace"];
      const patterns = record(value)
        ? value[ecosystem === "npm" ? "packages" : "members"]
        : value;
      if (strings(patterns)) {
        const excluded =
          ecosystem === "cargo" && record(value) && strings(value["exclude"])
            ? value["exclude"].map((pattern) => `!${pattern}`)
            : [];
        workspaces.set(path.posix.dirname(file), [...patterns, ...excluded]);
      }
    } catch {
      // Other toolchain rules validate manifests; retain the update root here.
    }
  }
  return manifests
    .filter((file) => {
      const directory = path.posix.dirname(file);
      return ![...workspaces].some(([root, patterns]) => {
        const relative = path.posix.relative(root, directory);
        if (relative === "" || relative.startsWith("../")) return false;
        const includes = patterns.filter((pattern) => !pattern.startsWith("!"));
        const excludes = patterns.filter((pattern) => pattern.startsWith("!"));
        return (
          includes.some((pattern) => picomatch.isMatch(relative, pattern)) &&
          !excludes.some((pattern) =>
            picomatch.isMatch(relative, pattern.slice(1)),
          )
        );
      });
    })
    .map(directoryOf);
};

type CheckDependabotOptions = {
  files: Record<string, string>;
  policy: DependabotPolicy;
};

const isDockerfile = (file: string) =>
  /^(?:Dockerfile|Containerfile)/.test(path.posix.basename(file));

const ecosystemRoots = (files: Record<string, string>) => {
  const roots = new Map<string, Set<string>>();
  const requireRoot = (ecosystem: string, directory: string) => {
    const directories = roots.get(ecosystem) ?? new Set<string>();
    directories.add(directory);
    roots.set(ecosystem, directories);
  };
  for (const directory of workspaceRoots(files, "npm"))
    requireRoot("npm", directory);
  for (const directory of workspaceRoots(files, "cargo"))
    requireRoot("cargo", directory);
  for (const file of Object.keys(files)) {
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file))
      requireRoot("github-actions", "/");
    const name = path.posix.basename(file);
    if (isDockerfile(file)) requireRoot("docker", directoryOf(file));
    if (
      name === "pyproject.toml" ||
      /^requirements(?:[.-][^/]*)?\.txt$/.test(name)
    )
      requireRoot("pip", directoryOf(file));
  }
  return roots;
};

const ignoredFor = (ecosystem: string, policy: DependabotPolicy) => {
  if (ecosystem === "npm") return policy.ignoredPackages;
  if (ecosystem === "github-actions") return policy.ignoredActions;
  if (ecosystem === "docker")
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
      return {
        "package-ecosystem": ecosystem,
        ...(directories.length === 1
          ? { directory: directories.at(0) }
          : { directories }),
        schedule: policy.schedule,
        cooldown: { "default-days": policy.cooldown.defaultDays },
        groups: Object.fromEntries(
          Object.entries(policy.groups).map(([name, group]) => [
            name,
            { patterns: group.patterns, "update-types": group.updateTypes },
          ]),
        ),
        ignore: ignoredFor(ecosystem, policy).map((name) => ({
          "dependency-name": name,
        })),
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
  const document = parseDocument(files[file] ?? "", { lineCounter });
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
    const directories =
      typeof single === "string" && multiple === undefined
        ? [single]
        : single === undefined && strings(multiple)
          ? multiple
          : [];
    if (
      directories.length === 0 ||
      directories.some(
        (directory) =>
          !directory.startsWith("/") || directory.split("/").includes(".."),
      )
    ) {
      report(
        "directory",
        `${ecosystem}: declare directory or nonempty directories with absolute repository paths`,
      );
    }
    const matches = covered.get(ecosystem) ?? new Set<string>();
    for (const root of roots.get(ecosystem) ?? []) {
      if (
        directories.some(
          (directory) =>
            directory === root ||
            (multiple !== undefined && picomatch.isMatch(root, directory)),
        )
      )
        matches.add(root);
    }
    covered.set(ecosystem, matches);
    const schedule = update["schedule"];
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
