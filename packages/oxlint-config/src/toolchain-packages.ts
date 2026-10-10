import path from "node:path";
import picomatch from "picomatch";
import { satisfies } from "semver";

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
  const reportedLines = new Map<string, number>();
  const add = ({ file, rule, key, value, message }: AddDiagnosticOptions) => {
    const serialized = JSON.stringify(value);
    const locationKey = `${file}:${key}:${serialized ?? ""}`;
    const previous = reportedLines.get(locationKey) ?? -1;
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
      line: Math.max(1, index + 1),
      message,
    });
  };
  for (const [file, text] of Object.entries(files)) {
    if (path.posix.basename(file) !== "package.json") continue;
    try {
      const json: unknown = JSON.parse(text);
      if (!record(json)) throw new Error("manifest must be an object");
      manifests.set(file, json);
    } catch {
      add({
        file,
        rule: "package-pins",
        key: "",
        message: "invalid package.json object",
      });
    }
  }
  const catalogSources = (json: Record<string, unknown>) => [
    json,
    ...(record(json["workspaces"]) ? [json["workspaces"]] : []),
  ];
  const catalogFor = (file: string, name: string): unknown => {
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
          /^(?:(?:bunx|npx|bun run|bun x)\s+(?:--[\w-]+\s+)*)?(?:tsc|tsgo)(?:\s|$)|^node\s+\S*\/bin\/(?:tsc|tsgo)(?:\.js)?(?:\s|$)/;
        const normalizedExpected = selectedLayout.typecheckCommand
          .replace(/\s+/g, " ")
          .trim();
        for (const segment of command.split(/&&|\|\||[;|\n]/)) {
          const normalized = segment.trim().replace(/\s+/g, " ");
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
