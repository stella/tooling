import path from "node:path";
import picomatch from "picomatch";
import { satisfies, valid, validRange } from "semver";
import { isNode, LineCounter, parseDocument } from "yaml";

import { nodeSupportRangeMatches } from "./toolchain-node";

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

// Inspect explicit substitution bodies without evaluating shell expressions.
const shellSubstitutions = (command: string) => {
  type Frame = {
    kind: "root" | "parentheses" | "backticks";
    start: number;
    depth: number;
    quote: "'" | '"' | undefined;
  };
  const frames: Frame[] = [
    { kind: "root", start: 0, depth: 0, quote: undefined },
  ];
  const bodies: string[] = [];
  for (let index = 0; index < command.length; index += 1) {
    const frame = frames.at(-1);
    if (frame === undefined) break;
    const character = command.at(index);
    if (character === "\\" && frame.quote !== "'") {
      index += 1;
      continue;
    }
    if (character === "`" && frame.kind === "backticks") {
      bodies.push(command.slice(frame.start, index));
      frames.pop();
      continue;
    }
    if (character === frame.quote) {
      frame.quote = undefined;
      continue;
    }
    if (frame.quote === "'") continue;
    if (character === "$" && command.at(index + 1) === "(") {
      frames.push({
        kind: "parentheses",
        start: index + 2,
        depth: 1,
        quote: undefined,
      });
      index += 1;
      continue;
    }
    if (character === "`") {
      frames.push({
        kind: "backticks",
        start: index + 1,
        depth: 0,
        quote: undefined,
      });
      continue;
    }
    if (frame.quote !== undefined) continue;
    if (character === "'" || character === '"') {
      frame.quote = character;
      continue;
    }
    if (frame.kind !== "parentheses") continue;
    if (character === "(") frame.depth += 1;
    if (character === ")" && --frame.depth === 0) {
      bodies.push(command.slice(frame.start, index));
      frames.pop();
    }
  }
  for (const frame of frames.slice(1)) bodies.push(command.slice(frame.start));
  return bodies;
};

// Preserve quoted assignment values when separating direct shell commands.
const compilerCommandSegments = (command: string) => {
  const segments: string[][] = [[]];
  for (const source of [command, ...shellSubstitutions(command)]) {
    segments.push([]);
    const shellWords = source.match(
      /(?:[^\s"'\\;&|()]|\\[^\n]|"(?:[^"\\]|\\.)*"|'[^']*')+|&&|\|\||[();&|\n]/g,
    );
    for (const word of shellWords ?? []) {
      if (/^(?:&&|\|\||[;&|\n])$/.test(word)) segments.push([]);
      else segments.at(-1)?.push(word);
    }
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
    return words.slice(start);
  });
};

const launcherValueOptions = new Map(
  Object.entries({
    npx: [
      "-p",
      "--package",
      "-c",
      "--call",
      "--cache",
      "--registry",
      "--userconfig",
    ],
    bunx: ["-p", "--package"],
    pnpm: ["--filter", "-F", "--dir", "-C", "--package"],
    yarn: [
      "--cwd",
      "--cache-folder",
      "--mutex",
      "--use-yarnrc",
      "--modules-folder",
      "--registry",
    ],
    bun: [
      "--cwd",
      "--filter",
      "-F",
      "--config",
      "-c",
      "--env-file",
      "-e",
      "--eval",
      "-p",
      "--print",
    ],
    node: [
      "-e",
      "--eval",
      "-p",
      "--print",
      "--conditions",
      "-C",
      "--inspect-port",
      "--max-old-space-size",
      "--stack-size",
      "--title",
      "--icu-data-dir",
      "--openssl-config",
      "--input-type",
    ],
  }).map(([launcher, options]) => [launcher, new Set(options)]),
);

// Classification sees launcher arguments; acceptance still uses the declared command.
const invokesCompiler = (words: string[]) => {
  const literal = (word: string) => {
    let result = "";
    let quote: "'" | '"' | undefined;
    for (let index = 0; index < word.length; index += 1) {
      const character = word.at(index);
      if (character === quote) {
        quote = undefined;
        continue;
      }
      if (quote === undefined && (character === "'" || character === '"')) {
        quote = character;
        continue;
      }
      const next = word.at(index + 1);
      if (
        character === "\\" &&
        next !== undefined &&
        quote !== "'" &&
        (quote === undefined || /[$`"\\\n]/.test(next))
      ) {
        result += next;
        index += 1;
      } else result += character;
    }
    return result;
  };
  const tokens = words.map(literal);
  const compiler = (word: string) =>
    /(?:^|\/)(?:tsc|tsgo)(?:\.js)?$/.test(word);
  let start = 0;
  const skipOptions = (index: number, launcher: string) => {
    while (tokens.at(index)?.startsWith("-")) {
      const option = tokens.at(index);
      index += 1;
      if (option === "--") break;
      if (
        option !== undefined &&
        launcherValueOptions.get(launcher)?.has(option)
      )
        index += 1;
    }
    return index;
  };
  while (start < tokens.length) {
    const launcher = tokens.at(start);
    if (launcher === undefined || !launcherValueOptions.has(launcher)) break;
    start = skipOptions(start + 1, launcher);
    if (launcher === "bun" && tokens.at(start) === "check") return true;
    const subcommand = tokens.at(start);
    if (
      (launcher === "bun" && (subcommand === "x" || subcommand === "run")) ||
      (launcher === "pnpm" &&
        (subcommand === "exec" || subcommand === "dlx")) ||
      (launcher === "yarn" &&
        (subcommand === "exec" || subcommand === "dlx" || subcommand === "run"))
    ) {
      start = skipOptions(start + 1, launcher);
    }
  }
  // Explicit compiler tokens behind unsupported launchers fail closed.
  const remaining = tokens.slice(start);
  return remaining.some(
    (word, index) =>
      compiler(word) ||
      (word === "bun" &&
        tokens.at(skipOptions(start + index + 1, "bun")) === "check"),
  );
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
  const sources = new Map(Object.entries(files));
  const diagnostics: Diagnostic[] = [];
  const pins = new Map(
    Object.entries({ ...policy.packages, "bun-types": policy.bun }),
  );
  const manifests = new Map<string, Record<string, unknown>>();
  const yamlLocations = new Map<string, number[]>();
  const reportedLines = new Map<string, number>();
  const add = ({ file, rule, key, value, message }: AddDiagnosticOptions) => {
    const source = sources.get(file);
    if (source === undefined)
      throw new Error(`Missing package diagnostic source: ${file}`);
    const serialized = value === undefined ? undefined : JSON.stringify(value);
    const locationKey = `${file}:${key}:${serialized ?? ""}`;
    const previous = reportedLines.get(locationKey) ?? -1;
    const yamlLine = yamlLocations.get(locationKey)?.shift();
    const index = source
      .split(/\r?\n/)
      .findIndex(
        (line, lineIndex) =>
          lineIndex > previous &&
          line.includes(JSON.stringify(key)) &&
          (serialized === undefined || line.includes(serialized)),
      );
    if (index >= 0) reportedLines.set(locationKey, index);
    diagnostics.push({
      rule,
      path: file,
      line: yamlLine ?? Math.max(1, index + 1),
      message,
    });
  };
  for (const [file, text] of sources) {
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
        { catalog: json["overrides"], prefix: ["overrides"] },
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
        !workspaceContains({
          directory,
          file,
          patterns: workspace["packages"],
          rootMembership: "implicit",
        })
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
  const workspaceContains = ({
    directory,
    file,
    patterns,
    rootMembership,
  }: {
    directory: string;
    file: string;
    patterns: unknown;
    rootMembership: "implicit" | "patterns";
  }) => {
    const relative = path.posix.relative(directory, path.posix.dirname(file));
    if (relative === "" && rootMembership === "implicit") return true;
    if (relative === ".." || relative.startsWith("../")) return false;
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
  const workspaceOwnerFor = (file: string) => {
    const pnpm = pnpmWorkspaceFor(file);
    if (pnpm !== undefined)
      return {
        directory: pnpm.directory,
        patterns: pnpm.workspace["packages"],
        source: "pnpm" as const,
      };
    let directory = path.posix.dirname(file);
    while (true) {
      const root = manifests.get(path.posix.join(directory, "package.json"));
      const workspaces = root?.["workspaces"];
      if (workspaces !== undefined)
        return {
          directory,
          patterns: record(workspaces) ? workspaces["packages"] : workspaces,
          source: "json" as const,
        };
      if (directory === ".") return undefined;
      directory = path.posix.dirname(directory);
    }
  };
  type WorkspaceResolution = "matched" | "nonmember" | "mismatch";
  const workspaceResolution = ({
    file,
    name,
    pin,
  }: {
    file: string;
    name: string;
    pin: string;
  }): WorkspaceResolution => {
    const owner = workspaceOwnerFor(file);
    if (owner === undefined) return "nonmember";
    const { directory, patterns, source } = owner;
    if (source === "json" && !Array.isArray(patterns)) return "mismatch";
    if (
      !workspaceContains({
        directory,
        file,
        patterns,
        rootMembership: "implicit",
      })
    )
      return "nonmember";
    const candidates = [...manifests.entries()].filter(
      ([candidate, json]) =>
        path.posix.basename(candidate) === "package.json" &&
        json["name"] === name &&
        workspaceContains({
          directory,
          file: candidate,
          patterns,
          rootMembership: source === "json" ? "patterns" : "implicit",
        }),
    );
    return candidates.length === 1 &&
      candidates.every(([, json]) => json["version"] === pin)
      ? "matched"
      : "mismatch";
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
        message: `packageManager Bun version must be ${policy.bun}, found ${JSON.stringify(manager)}`,
      });
    const dependencies: Record<string, unknown> = {};
    const checkEntries = (
      entries: unknown,
      installed: boolean,
      location?: { key: string; value: unknown },
    ) => {
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
              key: location?.key ?? name,
              value: location === undefined ? raw : location.value,
              message: `${name} must use a declared TypeScript specifier, found ${String(value)}`,
            });
          continue;
        }
        const pin = pins.get(name);
        if (pin === undefined) continue;
        if (value === pin) continue;
        const workspace =
          value === "workspace:*"
            ? workspaceResolution({ file, name, pin })
            : undefined;
        if (workspace === "matched") continue;
        add({
          file,
          rule: name === "bun-types" ? "bun-pins" : "package-pins",
          key: location?.key ?? name,
          value: location === undefined ? raw : location.value,
          message:
            workspace === "nonmember"
              ? `${name} workspace:* consumer is not a member of its nearest workspace`
              : `${name} must be ${pin}, found ${String(value)}`,
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
    const ownedNames = new Set([...pins.keys(), ...tsSpecifiers.keys()]);
    const resolutionDependencies: Record<string, unknown> = {};
    const resolutionRoot = manifests.get(
      path.posix.join(path.posix.dirname(file), "package.json"),
    );
    if (resolutionRoot !== undefined)
      for (const section of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
      ]) {
        const entries = resolutionRoot[section];
        if (!record(entries)) continue;
        for (const [name, value] of Object.entries(entries))
          resolutionDependencies[name] = resolve(file, name, value);
      }
    const affectedSpecifiers = new Map<string, Set<unknown>>();
    const owner = workspaceOwnerFor(file);
    for (const [candidate, member] of manifests) {
      if (path.posix.basename(candidate) !== "package.json") continue;
      const memberOwner = workspaceOwnerFor(candidate);
      const ownManifest =
        candidate === path.posix.join(path.posix.dirname(file), "package.json");
      if (
        !ownManifest &&
        !(
          owner !== undefined &&
          owner.directory === path.posix.dirname(file) &&
          memberOwner?.directory === owner.directory &&
          memberOwner.source === owner.source &&
          workspaceContains({
            directory: owner.directory,
            file: candidate,
            patterns: owner.patterns,
            rootMembership: "implicit",
          })
        )
      )
        continue;
      for (const section of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
      ]) {
        const entries = member[section];
        if (!record(entries)) continue;
        for (const [name, value] of Object.entries(entries)) {
          if (!tsSpecifiers.has(name)) continue;
          const values = affectedSpecifiers.get(name) ?? new Set<unknown>();
          values.add(resolve(candidate, name, value));
          affectedSpecifiers.set(name, values);
        }
      }
    }
    const checkResolutionMap = (entries: unknown, parent?: string) => {
      if (!record(entries)) return;
      for (const [selector, replacement] of Object.entries(entries)) {
        // npm's nested '.' replaces the enclosing package; Yarn and pnpm
        // qualify a target with a dependency path or a parent selector.
        const target = selector === "." ? parent : selector;
        if (target === undefined) continue;
        let pattern =
          target
            .split(/>\s*(?=[@A-Za-z_*]|$)/)
            .at(-1)
            ?.trim() ?? "";
        const version = pattern.lastIndexOf("@");
        let qualifier: string | undefined;
        if (version > pattern.lastIndexOf("/")) {
          qualifier = pattern.slice(version + 1).replace(/^npm:/, "");
          pattern = pattern.slice(0, version);
        }
        const parts = pattern.split("/");
        pattern = parts.at(-2)?.startsWith("@")
          ? parts.slice(-2).join("/")
          : (parts.at(-1) ?? "");
        if (pattern === "") {
          add({
            file,
            rule: "package-pins",
            key: selector,
            value: replacement,
            message: "resolution selector must name a package",
          });
          continue;
        }
        if (record(replacement)) {
          checkResolutionMap(replacement, target);
          continue;
        }
        for (const name of ownedNames) {
          if (!picomatch(pattern)(name)) continue;
          let value = replacement;
          if (typeof replacement === "string" && replacement.startsWith("$")) {
            const reference = replacement.slice(1);
            value = resolutionDependencies[reference];
          }
          const resolved = resolve(file, name, value);
          checkEntries({ [name]: value }, false, {
            key: selector,
            value: replacement,
          });
          if (
            tsSpecifiers.has(name) &&
            [...(affectedSpecifiers.get(name) ?? [])].some((specifier) => {
              if (resolved === specifier) return false;
              if (qualifier === undefined || validRange(qualifier) === null)
                return true;
              if (typeof specifier !== "string") return false;
              const versionSpecifier = specifier.startsWith("npm:")
                ? specifier.slice(specifier.lastIndexOf("@") + 1)
                : specifier;
              const release = valid(versionSpecifier);
              return release !== null && satisfies(release, qualifier);
            }) &&
            typeof resolved === "string" &&
            tsSpecifiers.get(name)?.has(resolved)
          )
            add({
              file,
              rule: "typescript-layout",
              key: selector,
              value: replacement,
              message: `${name} resolution must preserve its declared TypeScript install specifier`,
            });
        }
      }
    };
    checkResolutionMap(json["overrides"]);
    checkResolutionMap(json["resolutions"]);
    if (record(json["pnpm"])) checkResolutionMap(json["pnpm"]["overrides"]);
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
        const normalizedExpected = selectedLayout.typecheckCommand
          .replace(/\s+/g, " ")
          .trim();
        for (const words of compilerCommandSegments(command)) {
          if (!invokesCompiler(words)) continue;
          const normalized = words.join(" ");
          if (
            !words.some((word) => word === "(" || word === ")") &&
            shellSubstitutions(normalized).length === 0 &&
            (normalized === normalizedExpected ||
              normalized.startsWith(`${normalizedExpected} `))
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
        !nodeSupportRangeMatches(policy.node, json["engines"]["node"]))
    )
      add({
        file,
        rule: "node-engine",
        key: "node",
        value: json["engines"]["node"],
        message: `engines.node must support ${policy.node}, found ${JSON.stringify(json["engines"]["node"])}`,
      });
  }
  return diagnostics;
};
