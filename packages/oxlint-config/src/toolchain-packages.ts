import path from "node:path";
import picomatch from "picomatch";
import { satisfies } from "semver";
import { isNode, LineCounter, parseDocument } from "yaml";

export const packageRules = [
  "bun-pins",
  "package-pins",
  "typescript-layout",
  "node-engine",
] as const;

type Layout =
  | {
      type: "direct";
      compilerPackage: string;
      compilerSpecifier: string;
      typecheckCommand: string;
    }
  | {
      type: "split-compatibility";
      compilerPackage: string;
      compilerSpecifier: string;
      compatibilityPackage: string;
      compatibilitySpecifier: string;
      typecheckCommand: string;
    };

type PackagePolicy = {
  bun: string;
  packages: Record<string, string>;
  typescriptInstallLayouts: readonly Layout[];
  typescript6Compatibility: { version: string; packageAlias: string };
  node: string;
};

type Diagnostic = {
  rule: (typeof packageRules)[number];
  path: string;
  line: number;
  message: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Preserve quoted assignment values when separating direct shell commands.
const compilerCommandSegments = (command: string) => {
  const words = command.match(
    /(?:[^\s"'\\;&|]|\\[^\n]|"(?:[^"\\]|\\.)*"|'[^']*')+|&&|\|\||[;&|\n]/g,
  );
  const segments: string[][] = [[]];
  for (const word of words ?? []) {
    if (/^(?:&&|\|\||[;&|\n])$/.test(word)) segments.push([]);
    else segments.at(-1)?.push(word);
  }
  return segments.map((words) => {
    let start = 0;
    const skipAssignments = () => {
      while (/^[A-Za-z_][A-Za-z\d_]*=/.test(words.at(start) ?? "")) start += 1;
    };
    skipAssignments();
    while (/^(?:\/usr\/bin\/|\/bin\/)?env$/.test(words.at(start) ?? "")) {
      start += 1;
      while (start < words.length) {
        const option = words.at(start);
        if (option === "--") {
          start += 1;
          break;
        }
        if (option === "-u" || option === "--unset") {
          start += 2;
          continue;
        }
        if (
          option === "-" ||
          option === "-i" ||
          option === "--ignore-environment" ||
          /^--unset=.+|^-u.+/.test(option ?? "")
        ) {
          start += 1;
          continue;
        }
        break;
      }
      skipAssignments();
    }
    return words.slice(start).join(" ");
  });
};

type CheckPackageFilesOptions = {
  files: Record<string, string>;
  policy: PackagePolicy;
};

type AddDiagnosticOptions = {
  file: string;
  rule: Diagnostic["rule"];
  key: string;
  value?: unknown;
  message: string;
};

/** Validate manifests and catalog resolutions from a tracked-file snapshot. */
export const checkPackageFiles = ({
  files,
  policy,
}: CheckPackageFilesOptions) => {
  const diagnostics: Diagnostic[] = [];
  const pins = new Map(
    Object.entries({ ...policy.packages, "bun-types": policy.bun }),
  );
  const manifests = new Map<string, Record<string, unknown>>();
  const yamlLocations = new Map<string, number[]>();
  const reportedLines = new Map<string, number>();
  const add = ({ file, rule, key, value, message }: AddDiagnosticOptions) => {
    const serialized = JSON.stringify(value);
    const locationKey = `${file}:${key}:${serialized ?? ""}`;
    const previous = reportedLines.get(locationKey) ?? -1;
    const yamlLine = yamlLocations.get(locationKey)?.shift();
    const index =
      files[file]
        ?.split(/\r?\n/)
        .findIndex(
          (line, lineIndex) =>
            lineIndex > previous &&
            line.includes(JSON.stringify(key)) &&
            (serialized === undefined || line.includes(serialized)),
        ) ?? -1;
    if (index >= 0) reportedLines.set(locationKey, index);
    diagnostics.push({
      rule,
      path: file,
      line: yamlLine ?? Math.max(1, index + 1),
      message,
    });
  };
  for (const [file, text] of Object.entries(files)) {
    const pnpm = path.posix.basename(file) === "pnpm-workspace.yaml";
    if (!pnpm && path.posix.basename(file) !== "package.json") continue;
    try {
      const lineCounter = new LineCounter();
      const document = pnpm ? parseDocument(text, { lineCounter }) : undefined;
      if (document !== undefined && document.errors.length > 0)
        throw new Error("invalid YAML");
      const json: unknown =
        document === undefined ? JSON.parse(text) : document.toJS();
      if (!record(json)) throw new Error("manifest must be an object");
      if (pnpm) {
        if (json["catalog"] !== undefined && !record(json["catalog"]))
          throw new Error("catalog must be a mapping");
        if (
          json["catalogs"] !== undefined &&
          (!record(json["catalogs"]) ||
            Object.values(json["catalogs"]).some((catalog) => !record(catalog)))
        )
          throw new Error("named catalogs must be mappings");
        if (
          json["packages"] !== undefined &&
          (!Array.isArray(json["packages"]) ||
            !json["packages"].every(
              (pattern: unknown) => typeof pattern === "string",
            ))
        )
          throw new Error("workspace packages must be patterns");
      }
      manifests.set(file, json);
      if (document === undefined) continue;
      const catalogEntries = [
        { catalog: json["catalog"], prefix: ["catalog"] },
        ...(record(json["catalogs"])
          ? Object.entries(json["catalogs"]).map(([name, catalog]) => ({
              catalog,
              prefix: ["catalogs", name],
            }))
          : []),
      ];
      for (const { catalog, prefix } of catalogEntries) {
        if (!record(catalog)) continue;
        for (const [name, value] of Object.entries(catalog)) {
          const node = document.getIn([...prefix, name], true);
          if (!isNode(node) || node.range === undefined || node.range === null)
            continue;
          const key = `${file}:${name}:${JSON.stringify(value)}`;
          const lines = yamlLocations.get(key) ?? [];
          lines.push(lineCounter.linePos(node.range[0]).line);
          yamlLocations.set(key, lines);
        }
      }
    } catch {
      add({
        file,
        rule: "package-pins",
        key: "",
        message: pnpm
          ? "invalid pnpm-workspace.yaml object"
          : "invalid package.json object",
      });
    }
  }
  const catalogSources = (json: Record<string, unknown>) => [
    json,
    ...(record(json["workspaces"]) ? [json["workspaces"]] : []),
  ];
  const pnpmWorkspaceFor = (file: string) => {
    let directory = path.posix.dirname(file);
    while (true) {
      const workspace = manifests.get(
        path.posix.join(directory, "pnpm-workspace.yaml"),
      );
      if (workspace !== undefined) return { directory, workspace };
      if (directory === ".") return undefined;
      directory = path.posix.dirname(directory);
    }
  };
  const catalogFor = (file: string, name: string): unknown => {
    const owner = pnpmWorkspaceFor(file);
    if (owner !== undefined) {
      const { directory, workspace } = owner;
      if (
        path.posix.basename(file) === "package.json" &&
        !pnpmContains({ directory, file, patterns: workspace["packages"] })
      )
        return undefined;
      if (name === "" || name === "default")
        return (
          workspace["catalog"] ??
          (record(workspace["catalogs"])
            ? workspace["catalogs"]["default"]
            : undefined)
        );
      return record(workspace["catalogs"])
        ? workspace["catalogs"][name]
        : undefined;
    }
    let directory = path.posix.dirname(file);
    while (true) {
      const manifest = manifests.get(
        path.posix.join(directory, "package.json"),
      );
      if (manifest !== undefined) {
        for (const source of catalogSources(manifest)) {
          if (name === "" && source["catalog"] !== undefined)
            return source["catalog"];
          if (
            record(source["catalogs"]) &&
            source["catalogs"][name] !== undefined
          )
            return source["catalogs"][name];
        }
        // A workspace owns catalog resolution even when the requested catalog is absent.
        if (manifest["workspaces"] !== undefined) return undefined;
      }
      if (directory === ".") return undefined;
      directory = path.posix.dirname(directory);
    }
  };
  const pnpmContains = ({
    directory,
    file,
    patterns,
  }: {
    directory: string;
    file: string;
    patterns: unknown;
  }) => {
    const relative = path.posix.relative(directory, path.posix.dirname(file));
    if (relative === "") return true;
    if (!Array.isArray(patterns)) return false;
    const normalize = (pattern: string) => path.posix.normalize(pattern);
    const selected = patterns.filter(
      (value: unknown): value is string => typeof value === "string",
    );
    return (
      picomatch(
        selected.filter((pattern) => !pattern.startsWith("!")).map(normalize),
      )(relative) &&
      !picomatch(
        selected
          .filter((pattern) => pattern.startsWith("!"))
          .map((pattern) => normalize(pattern.slice(1))),
      )(relative)
    );
  };
  const resolve = (file: string, name: string, value: unknown): unknown => {
    const visited = new Set<string>();
    while (typeof value === "string" && value.startsWith("catalog:")) {
      if (visited.has(value)) return undefined;
      visited.add(value);
      const catalog = catalogFor(file, value.slice("catalog:".length));
      value = record(catalog) ? catalog[name] : undefined;
    }
    return value;
  };
  const workspaceMatches = ({
    file,
    name,
    pin,
  }: {
    file: string;
    name: string;
    pin: string;
  }) => {
    const owner = pnpmWorkspaceFor(file);
    if (owner !== undefined) {
      const { directory, workspace } = owner;
      if (!pnpmContains({ directory, file, patterns: workspace["packages"] }))
        return false;
      const candidates = [...manifests.entries()].filter(
        ([candidate, json]) =>
          path.posix.basename(candidate) === "package.json" &&
          json["name"] === name &&
          pnpmContains({
            directory,
            file: candidate,
            patterns: workspace["packages"],
          }),
      );
      return (
        candidates.length === 1 &&
        candidates.every(([, json]) => json["version"] === pin)
      );
    }
    let directory = path.posix.dirname(file);
    while (true) {
      const root = manifests.get(path.posix.join(directory, "package.json"));
      const workspaces = root?.["workspaces"];
      if (workspaces !== undefined) {
        const patterns = record(workspaces)
          ? workspaces["packages"]
          : workspaces;
        if (!Array.isArray(patterns)) return false;
        const workspacePatterns = patterns.filter(
          (pattern: unknown): pattern is string => typeof pattern === "string",
        );
        const included = picomatch(
          workspacePatterns.filter((pattern) => !pattern.startsWith("!")),
        );
        const excluded = picomatch(
          workspacePatterns
            .filter((pattern) => pattern.startsWith("!"))
            .map((pattern) => pattern.slice(1)),
        );
        const candidates = [...manifests.entries()].filter(
          ([candidate, json]) => {
            if (json["name"] !== name) return false;
            const relative = path.posix.relative(
              directory,
              path.posix.dirname(candidate),
            );
            return included(relative) && !excluded(relative);
          },
        );
        return (
          candidates.length === 1 &&
          candidates.every(([, json]) => json["version"] === pin)
        );
      }
      if (directory === ".") return false;
      directory = path.posix.dirname(directory);
    }
  };
  const tsSpecifiers = new Map<string, Set<string>>();
  for (const layout of policy.typescriptInstallLayouts) {
    const values =
      tsSpecifiers.get(layout.compilerPackage) ?? new Set<string>();
    values.add(layout.compilerSpecifier);
    tsSpecifiers.set(layout.compilerPackage, values);
    if (layout.type !== "split-compatibility") continue;
    const compatibility =
      tsSpecifiers.get(layout.compatibilityPackage) ?? new Set<string>();
    compatibility.add(layout.compatibilitySpecifier);
    tsSpecifiers.set(layout.compatibilityPackage, compatibility);
  }
  tsSpecifiers.set(
    policy.typescript6Compatibility.packageAlias,
    new Set([`npm:typescript@${policy.typescript6Compatibility.version}`]),
  );
  for (const [file, json] of manifests) {
    const manager = json["packageManager"];
    if (manager !== undefined && manager !== `bun@${policy.bun}`)
      add({
        file,
        rule: "bun-pins",
        key: "packageManager",
        value: manager,
        message: `packageManager Bun version must be ${policy.bun}, found ${String(manager)}`,
      });
    const dependencies: Record<string, unknown> = {};
    const checkEntries = (entries: unknown, installed: boolean) => {
      if (!record(entries)) return;
      for (const [name, raw] of Object.entries(entries)) {
        const value = resolve(file, name, raw);
        if (installed) dependencies[name] = value;
        const tsAllowed = tsSpecifiers.get(name);
        if (tsAllowed !== undefined) {
          if (typeof value !== "string" || !tsAllowed.has(value))
            add({
              file,
              rule: "typescript-layout",
              key: name,
              value: raw,
              message: `${name} must use a declared TypeScript specifier, found ${String(value)}`,
            });
          continue;
        }
        const pin = pins.get(name);
        if (pin === undefined) continue;
        if (
          value === pin ||
          (value === "workspace:*" && workspaceMatches({ file, name, pin }))
        )
          continue;
        add({
          file,
          rule: name === "bun-types" ? "bun-pins" : "package-pins",
          key: name,
          value: raw,
          message: `${name} must be ${pin}, found ${String(value)}`,
        });
      }
    };
    for (const key of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ])
      checkEntries(json[key], true);
    for (const source of catalogSources(json)) {
      checkEntries(source["catalog"], false);
      if (!record(source["catalogs"])) continue;
      for (const catalog of Object.values(source["catalogs"]))
        checkEntries(catalog, false);
    }
    const usesCompiler = policy.typescriptInstallLayouts.some(
      (layout) => dependencies[layout.compilerPackage] !== undefined,
    );
    if (usesCompiler) {
      const selectedLayout = policy.typescriptInstallLayouts.find((layout) => {
        if (dependencies[layout.compilerPackage] !== layout.compilerSpecifier)
          return false;
        if (layout.type === "split-compatibility")
          return (
            dependencies[layout.compatibilityPackage] ===
            layout.compatibilitySpecifier
          );
        return policy.typescriptInstallLayouts.every(
          (other) =>
            other.compilerPackage === layout.compilerPackage ||
            dependencies[other.compilerPackage] === undefined,
        );
      });
      if (selectedLayout === undefined)
        add({
          file,
          rule: "typescript-layout",
          key: "dependencies",
          message:
            "TypeScript compiler and compatibility packages must match one complete declared install layout",
        });
      const command = record(json["scripts"])
        ? json["scripts"]["typecheck"]
        : undefined;
      if (selectedLayout !== undefined && typeof command === "string") {
        const directCompiler =
          /^bun\s+check(?:\s|$)|^(?:(?:bunx|npx|bun run|bun x)\s+(?:--[\w-]+\s+)*)?(?:\S*\/)?(?:tsc|tsgo)(?:\.js)?(?:\s|$)|^node\s+\S*\/bin\/(?:tsc|tsgo)(?:\.js)?(?:\s|$)/;
        const normalizedExpected = selectedLayout.typecheckCommand
          .replace(/\s+/g, " ")
          .trim();
        for (const normalized of compilerCommandSegments(command)) {
          if (!directCompiler.test(normalized)) continue;
          if (
            normalized === normalizedExpected ||
            normalized.startsWith(`${normalizedExpected} `)
          )
            continue;
          add({
            file,
            rule: "typescript-layout",
            key: "typecheck",
            value: command,
            message: `typecheck compiler invocation must use ${selectedLayout.typecheckCommand}`,
          });
          break;
        }
      }
    }
    if (
      record(json["engines"]) &&
      json["engines"]["node"] !== undefined &&
      (typeof json["engines"]["node"] !== "string" ||
        !satisfies(policy.node, json["engines"]["node"]))
    )
      add({
        file,
        rule: "node-engine",
        key: "node",
        value: json["engines"]["node"],
        message: `engines.node must support ${policy.node}, found ${String(json["engines"]["node"])}`,
      });
  }
  return diagnostics;
};
