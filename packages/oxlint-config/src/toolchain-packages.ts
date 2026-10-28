import path from "node:path";
import picomatch from "picomatch";
import { satisfies, valid, validRange } from "semver";
import { isNode, LineCounter, parseDocument } from "yaml";

import { nodeSupportRangeMatches } from "./toolchain-node";
import { sourceApiImportProblem } from "./toolchain-typescript-source-api";
import { workspaceContains } from "./toolchain-workspaces";

export const packageRules = [
  "bun-pins",
  "package-pins",
  "typescript-layout",
  "node-engine",
] as const;

type PackagePolicy = {
  bun: string;
  packages: Record<string, string>;
  typescript: string;
  node: string;
};

/** Compiler packages `bun check` replaces; an install needs a repository allowlist entry. */
const typescriptPackages: ReadonlySet<string> = new Set([
  "typescript",
  "@typescript/native",
]);
const typecheckCommand = "bun check";
const typescriptGuidance =
  "type check with `bun check --no-pretty --all --project=<tsconfig>`, use tsrs for programs and type checkers, and oxc-parser for syntax-only reads";
const installSections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const;
const allowlistFile = "stll-toolchain.json";

type Diagnostic = {
  rule: (typeof packageRules)[number];
  path: string;
  line: number;
  message: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `npm:typescript@7.0.2` installs a compiler under another name; returns its version. */
const typescriptAliasVersion = (spec: unknown) => {
  if (typeof spec !== "string") return undefined;
  const match = /^npm:(?:typescript|@typescript\/native)(?:@(.*))?$/.exec(spec);
  return match === null ? undefined : (match[1] ?? "");
};
const exactTypescriptSpec = (spec: unknown): spec is string => {
  if (typeof spec !== "string") return false;
  const version = typescriptAliasVersion(spec) ?? spec;
  return valid(version) === version;
};
const isTypescriptInstall = (name: string, value: unknown) =>
  typescriptPackages.has(name) || typescriptAliasVersion(value) !== undefined;

/** One repository-declared TypeScript install: where, what, and which dependency needs it. */
type TypescriptAllowlistBase = {
  workspace: string;
  name: string;
  spec: string;
  reason: string;
};
export type TypescriptAllowlistEntry = TypescriptAllowlistBase &
  (
    | { kind?: "dependency"; dependency: string }
    | { kind: "source-api"; sources: readonly string[] }
  );

const allowlistKeys = [
  "workspace",
  "name",
  "spec",
  "dependency",
  "reason",
] as const;
const allowlistFormat =
  '{"workspace": "<package directory or .>", "name": "typescript", "spec": "<exact version>", "dependency": "<package that needs it>", "reason": "<why>"}';
const workspaceManifest = (workspace: string) =>
  workspace === "." ? "package.json" : `${workspace}/package.json`;

/** Each repository declares its own TypeScript installs; there is no shared list. */
export const parseTypescriptAllowlist = (
  input: unknown,
): TypescriptAllowlistEntry[] => {
  if (input === undefined) return [];
  if (!Array.isArray(input))
    throw new Error(
      `typescriptAllowlist must be an array of entries like ${allowlistFormat}`,
    );
  const seen = new Set<string>();
  return input.map((entry: unknown) => {
    const shown = JSON.stringify(entry);
    const text = (key: string) => {
      const value = record(entry) ? entry[key] : undefined;
      return typeof value === "string" && value.trim() !== ""
        ? value
        : undefined;
    };
    const workspace = text("workspace");
    const name = text("name");
    const spec = text("spec");
    const dependency = text("dependency");
    const sourceApi = record(entry) && entry["kind"] === "source-api";
    const keys = sourceApi
      ? ["workspace", "name", "spec", "reason", "kind", "sources"]
      : [
          ...allowlistKeys,
          ...(record(entry) && entry["kind"] === "dependency" ? ["kind"] : []),
        ];
    const reason = text("reason");
    if (
      !record(entry) ||
      Object.keys(entry).length !== keys.length ||
      Object.keys(entry).some((key) => !keys.includes(key)) ||
      workspace === undefined ||
      name === undefined ||
      spec === undefined ||
      (!sourceApi && dependency === undefined) ||
      reason === undefined
    )
      throw new Error(
        `typescriptAllowlist entry ${shown} must have exactly workspace, name, spec, dependency and reason as nonempty strings: ${allowlistFormat}`,
      );
    if (
      workspace !== "." &&
      (path.posix.normalize(workspace) !== workspace ||
        workspace.startsWith("/") ||
        workspace.endsWith("/") ||
        workspace === ".." ||
        workspace.startsWith("../"))
    )
      throw new Error(
        `typescriptAllowlist entry ${shown}: workspace must be "." for the root or a normalized relative package directory such as "apps/web"`,
      );
    if (!exactTypescriptSpec(spec))
      throw new Error(
        `typescriptAllowlist entry ${shown}: spec must be the exact spec the manifest resolves to, such as "6.0.3" or "npm:typescript@6.0.3", not a range or catalog reference`,
      );
    if (!isTypescriptInstall(name, spec))
      throw new Error(
        `typescriptAllowlist entry ${shown}: name must be typescript or @typescript/native, or an alias whose spec is npm:typescript@<version> or npm:@typescript/native@<version>`,
      );
    if (
      dependency !== undefined &&
      (typescriptPackages.has(dependency) || dependency === name)
    )
      throw new Error(
        `typescriptAllowlist entry ${shown}: dependency must name the package in that workspace that needs ${name}, not a TypeScript package`,
      );
    const key = `${workspace}\0${name}`;
    if (seen.has(key))
      throw new Error(
        `typescriptAllowlist declares ${name} for ${workspace} more than once; keep one entry`,
      );
    seen.add(key);
    if (sourceApi) {
      const sources: unknown = entry["sources"];
      if (
        !Array.isArray(sources) ||
        sources.length === 0 ||
        !sources.every(
          (source: unknown): source is string =>
            typeof source === "string" &&
            path.posix.normalize(source) === source &&
            !source.startsWith("/") &&
            source !== ".." &&
            !source.startsWith("../") &&
            !source.includes("\\") &&
            !/[?*{}[\]]/.test(source) &&
            /\.[cm]?[jt]sx?$/.test(source) &&
            !/\.d\.[cm]?ts$/.test(source) &&
            !source
              .split("/")
              .some((part) => ["node_modules", "vendor"].includes(part)),
        ) ||
        new Set(sources).size !== sources.length
      )
        throw new Error(
          `typescriptAllowlist source-api entry ${shown} requires unique normalized source file paths`,
        );
      return { kind: "source-api", workspace, name, spec, reason, sources };
    }
    if (dependency === undefined)
      throw new Error("Missing TypeScript dependency owner");
    return { workspace, name, spec, dependency, reason };
  });
};

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

const shellValueOptions = new Set([
  "--rcfile",
  "--init-file",
  "-o",
  "+o",
  "-O",
  "+O",
]);
const shellExecutable = /^(?:\/(?:[^/]+\/)*)?(?:bash|dash|ksh|zsh|sh)$/;

type ShellToken = {
  kind: "word" | "boundary" | "redirect" | "comment";
  value: string;
  index: number;
};

// Keep expansion bodies in their word: substitutions are inspected separately as executable sources.
export const shellTokens = (source: string) => {
  const tokens: ShellToken[] = [];
  for (let index = 0; index < source.length;) {
    const character = source.at(index);
    if (character === undefined) break;
    if (character === "\n") {
      tokens.push({ kind: "boundary", value: character, index: index++ });
      continue;
    }
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (character === "#") {
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? source.length : end;
      tokens.push({ kind: "comment", value: source.slice(index, stop), index });
      index = stop;
      continue;
    }
    const redirect = /^(?:\d*)(?:&>>|&>|<<<|<<-|<<|>>|>\||>&|<&|<>|>|<)/.exec(
      source.slice(index),
    );
    if (redirect !== null) {
      tokens.push({ kind: "redirect", value: redirect[0], index });
      index += redirect[0].length;
      continue;
    }
    const boundary = /^(?:&&|\|\||[();&|])/.exec(source.slice(index));
    if (boundary !== null) {
      tokens.push({ kind: "boundary", value: boundary[0], index });
      index += boundary[0].length;
      continue;
    }
    const start = index;
    type Frame = {
      kind: "word" | "parentheses" | "backticks";
      quote: "'" | '"' | undefined;
      depth: number;
    };
    const frames: Frame[] = [{ kind: "word", quote: undefined, depth: 0 }];
    while (index < source.length) {
      const frame = frames.at(-1);
      const current = source.at(index);
      if (frame === undefined || current === undefined) break;
      if (current === "\\" && frame.quote !== "'") {
        index += 2;
        continue;
      }
      if (current === "`" && frame.kind === "backticks") {
        frames.pop();
        index++;
        continue;
      }
      if (current === frame.quote) {
        frame.quote = undefined;
        index++;
        continue;
      }
      if (frame.quote === "'") {
        index++;
        continue;
      }
      if (current === "$" && source.at(index + 1) === "(") {
        frames.push({ kind: "parentheses", quote: undefined, depth: 1 });
        index += 2;
        continue;
      }
      if (current === "`") {
        frames.push({ kind: "backticks", quote: undefined, depth: 0 });
        index++;
        continue;
      }
      if (frame.quote !== undefined) {
        index++;
        continue;
      }
      if (current === "'" || current === '"') {
        frame.quote = current;
        index++;
        continue;
      }
      if (frame.kind === "parentheses") {
        if (current === "(") frame.depth++;
        if (current === ")" && --frame.depth === 0) frames.pop();
        index++;
        continue;
      }
      if (frame.kind === "word" && /[\s<>;&|()]/.test(current)) break;
      index++;
    }
    const value = source.slice(start, index);
    tokens.push({
      kind: "word",
      value,
      index: start,
    });
  }
  // Braces are reserved words only where a command or function body can begin.
  let groupDepth = 0;
  let redirectTarget = false;
  const commandWords: string[] = [];
  for (const token of tokens) {
    if (token.kind === "comment") continue;
    if (token.kind === "redirect") {
      redirectTarget = true;
      continue;
    }
    if (redirectTarget) {
      redirectTarget = false;
      if (token.kind === "word") continue;
    }
    if (token.kind === "boundary") {
      commandWords.length = 0;
      continue;
    }
    const functionBody =
      commandWords.length === 2 && commandWords.at(0) === "function";
    const opensGroup =
      token.value === "{" && (commandWords.length === 0 || functionBody);
    const closesGroup =
      token.value === "}" && groupDepth > 0 && commandWords.length === 0;
    if (opensGroup || closesGroup) {
      token.kind = "boundary";
      groupDepth += opensGroup ? 1 : -1;
      commandWords.length = 0;
      continue;
    }
    if (
      commandWords.length === 0 &&
      ["if", "then", "elif", "else", "do", "!", "time"].includes(token.value)
    )
      continue;
    commandWords.push(token.value);
  }
  return tokens;
};

const shellArgumentTokens = (tokens: readonly ShellToken[]) => {
  const arguments_: ShellToken[] = [];
  let redirectTarget = false;
  for (const token of tokens) {
    if (token.kind === "comment") continue;
    if (token.kind === "redirect") {
      redirectTarget = true;
      continue;
    }
    if (redirectTarget) {
      redirectTarget = false;
      if (token.kind === "word") continue;
    }
    arguments_.push(token);
  }
  return arguments_;
};

const shellReadsProgramStdin = (tokens: readonly ShellToken[]) => {
  const words = executableShellWords(
    shellArgumentTokens(tokens).map(({ value }) => value),
  ).map(decodeShellWord);
  if (!shellExecutable.test(words.at(0) ?? "")) return false;
  let stdin = false;
  let script = false;
  for (let index = 1; index < words.length; index++) {
    const option = words.at(index) ?? "";
    if (option === "--" || option === "-") {
      script = index + 1 < words.length;
      break;
    }
    if (!/^[+-]/.test(option)) {
      script = true;
      break;
    }
    if (shellValueOptions.has(option)) {
      index++;
      continue;
    }
    if (/^-[^-]*c/.test(option)) return false;
    if (/^-[^-]*s/.test(option)) stdin = true;
  }
  return stdin || !script;
};

// Descriptor copies retain their source; later redirections replace only their destination.
const shellStdinHeredoc = (tokens: readonly ShellToken[]) => {
  const descriptors = new Map<string, ShellToken>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens.at(index);
    if (token?.kind !== "redirect") continue;
    const declaration = /^(\d*)(.+)$/.exec(token.value);
    const operator = declaration?.[2];
    if (operator === undefined) continue;
    const descriptor = String(
      Number(declaration?.[1] || (operator.startsWith("<") ? "0" : "1")),
    );
    const target = tokens.at(++index);
    if (operator === "<<" || operator === "<<-") {
      descriptors.set(descriptor, token);
      continue;
    }
    if (operator === "<&" || operator === ">&") {
      const copy = /^(\d+)(-?)$/.exec(decodeShellWord(target?.value ?? ""));
      const sourceDescriptor =
        copy?.[1] === undefined ? undefined : String(Number(copy[1]));
      const source =
        sourceDescriptor === undefined
          ? undefined
          : descriptors.get(sourceDescriptor);
      if (source === undefined) descriptors.delete(descriptor);
      else descriptors.set(descriptor, source);
      if (copy?.[2] === "-" && sourceDescriptor !== undefined)
        descriptors.delete(sourceDescriptor);
      continue;
    }
    descriptors.delete(descriptor);
    if (operator === "&>" || operator === "&>>") descriptors.delete("2");
  }
  return descriptors.get("0");
};

// Literal heredoc bodies are data, not direct shell command invocations.
const shellExecutableSource = (command: string) => {
  const pending: {
    delimiter: string;
    stripTabs: boolean;
    literal: boolean;
    execute: boolean;
  }[] = [];
  return command
    .split(/\r?\n/)
    .map((line) => {
      const here = pending.at(0);
      if (here !== undefined) {
        if (
          (here.stripTabs ? line.replace(/^\t+/, "") : line) === here.delimiter
        ) {
          pending.shift();
          return "";
        }
        if (here.execute) return line;
        if (here.literal) return "";
        return shellSubstitutions(line).join("\n");
      }
      const words = shellTokens(line);
      let commandStart = 0;
      for (let index = 0; index < words.length; index++) {
        const match = words.at(index);
        const word = match?.value;
        if (word === undefined) continue;
        if (match?.kind === "comment") return line.slice(0, match.index);
        if (match?.kind === "boundary") {
          commandStart = index + 1;
          continue;
        }
        const declaration =
          match?.kind === "redirect" ? /^(?:\d*)<<(-?)(.*)$/.exec(word) : null;
        let delimiter = declaration?.[2];
        if (delimiter === "") delimiter = words.at(++index)?.value;
        if (
          declaration !== null &&
          delimiter !== undefined &&
          !delimiter.startsWith("<")
        ) {
          const commandEnd = words.findIndex(
            (entry, position) =>
              position > index &&
              (entry.kind === "boundary" || entry.kind === "comment"),
          );
          const invocation = words.slice(
            commandStart,
            commandEnd < 0 ? undefined : commandEnd,
          );
          pending.push({
            delimiter: decodeShellWord(delimiter),
            stripTabs: declaration[1] === "-",
            literal: /['"\\]/.test(delimiter),
            execute:
              shellReadsProgramStdin(invocation) &&
              shellStdinHeredoc(invocation) === match,
          });
        }
      }
      return line;
    })
    .join("\n");
};

export const executableShellWords = (words: readonly string[]): string[] => {
  let start = 0;
  const skipAssignments = () => {
    while (
      /^[A-Za-z_][A-Za-z\d_]*=/.test(decodeShellWord(words.at(start) ?? ""))
    )
      start += 1;
  };
  skipAssignments();
  while (
    /^(?:\/usr\/bin\/|\/bin\/)?env$/.test(
      decodeShellWord(words.at(start) ?? ""),
    )
  ) {
    start += 1;
    while (start < words.length) {
      const option = decodeShellWord(words.at(start) ?? "");
      if (option === "--") {
        start += 1;
        break;
      }
      if (["-u", "--unset", "-C", "--chdir"].includes(option)) {
        start += 2;
        continue;
      }
      if (
        option === "-S" ||
        option === "--split-string" ||
        option.startsWith("--split-string=") ||
        (option.startsWith("-S") && option.length > 2)
      ) {
        let source: string;
        if (option === "-S" || option === "--split-string") {
          source = decodeShellWord(words.at(start + 1) ?? "");
          start += 2;
        } else {
          source = option.startsWith("-S")
            ? option.slice(2)
            : option.slice("--split-string=".length);
          start++;
        }
        return executableShellWords([
          "env",
          ...shellTokens(source).map(({ value }) => value),
          ...words.slice(start),
        ]);
      }
      if (
        option === "-" ||
        option === "-i" ||
        option === "--ignore-environment" ||
        /^--(?:unset|chdir)=.+|^-[uC].+/.test(option)
      ) {
        start += 1;
        continue;
      }
      break;
    }
    skipAssignments();
  }
  return words.slice(start);
};

// A quoted argument is executable only when the command itself is a shell with -c.
const shellCommandBody = (rawWords: readonly string[]) => {
  const words = executableShellWords(
    rawWords.filter((word) => word !== "(" && word !== ")"),
  ).map(decodeShellWord);
  if (!shellExecutable.test(words.at(0) ?? "")) return undefined;
  for (let index = 1; index < words.length; index++) {
    const option = words.at(index);
    if (option === undefined || option === "--" || !/^[+-]/.test(option))
      return undefined;
    if (shellValueOptions.has(option)) {
      index++;
      continue;
    }
    if (/^-[^-]*c/.test(option)) return words.at(index + 1);
  }
  return undefined;
};

/** Shared executable shell words preserve assignments for runtime selectors. */
export const shellCommandSegments = (
  command: string,
  grouping: "boundaries" | "tokens" = "boundaries",
) => {
  const segments: string[][] = [[]];
  const executableSource = shellExecutableSource(command);
  const sources = new Set([
    executableSource,
    ...shellSubstitutions(executableSource),
  ]);
  for (const source of sources) {
    const firstSegment = segments.length;
    segments.push([]);
    for (const { kind, value: word } of shellArgumentTokens(
      shellTokens(source),
    )) {
      if (kind === "boundary") {
        if (["(", ")", "{", "}"].includes(word) && grouping === "tokens")
          segments.at(-1)?.push(word);
        else segments.push([]);
      } else segments.at(-1)?.push(word);
    }
    for (const words of segments.slice(firstSegment)) {
      const body = shellCommandBody(words);
      if (body === undefined) continue;
      const executableBody = shellExecutableSource(body);
      sources.add(executableBody);
      for (const substitution of shellSubstitutions(executableBody))
        sources.add(substitution);
    }
  }
  return segments;
};

// Inspect direct compiler commands after removing environment launcher assignments.
export const compilerCommandSegments = (command: string) =>
  // Compiler policy compares raw invocations; retaining grouping prevents widening its allowlist.
  shellCommandSegments(command, "tokens").map(executableShellWords);

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

export const decodeShellWord = (word: string) => {
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
      if (next !== "\n") result += next;
      index += 1;
    } else result += character;
  }
  return result;
};

// Classification sees launcher arguments; acceptance still uses the declared command.
const invokesCompiler = (words: string[]) => {
  const tokens = words.map(decodeShellWord);
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
  /** The repository's own TypeScript installs from `stll-toolchain.json`. */
  typescriptAllowlist: readonly TypescriptAllowlistEntry[];
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
  typescriptAllowlist,
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
  // `catalogs` lists every catalog the reference passed through.
  const resolveThrough = (file: string, name: string, value: unknown) => {
    const visited = new Set<string>();
    const catalogs: Record<string, unknown>[] = [];
    while (typeof value === "string" && value.startsWith("catalog:")) {
      if (visited.has(value)) return { value: undefined, catalogs };
      visited.add(value);
      const catalog = catalogFor(file, value.slice("catalog:".length));
      if (!record(catalog)) return { value: undefined, catalogs };
      catalogs.push(catalog);
      value = catalog[name];
    }
    return { value, catalogs };
  };
  const resolve = (file: string, name: string, value: unknown): unknown =>
    resolveThrough(file, name, value).value;
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
  // TypeScript installs exist only where the repository allowlists them.
  const allowed = new Map(
    typescriptAllowlist.map((entry) => [
      `${workspaceManifest(entry.workspace)}\0${entry.name}`,
      entry,
    ]),
  );
  // A catalog may hold a TypeScript entry only for an allowed install that
  // resolves through it to the allowed spec.
  const allowedCatalogEntries = new Map<Record<string, unknown>, Set<string>>();
  for (const entry of typescriptAllowlist) {
    const file = workspaceManifest(entry.workspace);
    const json = manifests.get(file);
    if (json === undefined) continue;
    for (const section of installSections) {
      const entries = json[section];
      if (!record(entries) || !Object.hasOwn(entries, entry.name)) continue;
      const { value, catalogs } = resolveThrough(
        file,
        entry.name,
        entries[entry.name],
      );
      if (value !== entry.spec) continue;
      for (const catalog of catalogs) {
        const names = allowedCatalogEntries.get(catalog) ?? new Set<string>();
        names.add(entry.name);
        allowedCatalogEntries.set(catalog, names);
      }
    }
  }
  const shownSpec = (raw: unknown, value: unknown) => {
    if (typeof value !== "string") return `${String(raw)} (unresolved)`;
    return raw === value ? value : `${value} (from ${String(raw)})`;
  };
  const typescriptMessage = (name: string, value: unknown) =>
    `${name} ${String(value)} is not needed: ${typescriptGuidance}`;
  type EntryScope = "install" | "catalog" | "peer" | "resolution";
  const typescriptEntryMessage = ({
    file,
    entries,
    name,
    raw,
    value,
    scope,
  }: {
    file: string;
    entries: Record<string, unknown>;
    name: string;
    raw: unknown;
    value: unknown;
    scope: EntryScope;
  }) => {
    const shown = shownSpec(raw, value);
    if (scope === "catalog")
      return allowedCatalogEntries.get(entries)?.has(name) === true
        ? undefined
        : `${name} ${shown} in a catalog of ${file} serves no allowed install: ${typescriptGuidance}; a catalog may hold ${name} only at the spec of a workspace entry in typescriptAllowlist in ${allowlistFile}`;
    if (scope === "resolution")
      return `${name} must not be overridden or resolved (${shown}): ${typescriptGuidance}; declare it in the workspace whose dependency needs it and add a typescriptAllowlist entry in ${allowlistFile}`;
    if (scope === "peer")
      return `${name} peer ${shown} is not a version range: ${typescriptGuidance}`;
    const entry =
      path.posix.basename(file) === "package.json"
        ? allowed.get(`${file}\0${name}`)
        : undefined;
    if (entry === undefined) {
      const workspace = path.posix.dirname(file);
      const suggestion = JSON.stringify({
        workspace,
        name,
        spec: exactTypescriptSpec(value) ? value : "<exact version>",
        dependency: "<package that needs it>",
        reason: "<why it needs this TypeScript>",
      });
      return `${name} ${shown} in ${file} is not allowed: ${typescriptGuidance}; if a dependency of this workspace needs it, add ${suggestion} to typescriptAllowlist in ${allowlistFile}`;
    }
    return value === entry.spec
      ? undefined
      : `${name} in ${file} resolves to ${shown}, but typescriptAllowlist in ${allowlistFile} allows ${entry.spec} for ${entry.kind === "source-api" ? "source API imports" : entry.dependency}; declare ${entry.spec} or update the entry's spec`;
  };
  const peerRange = (value: unknown): value is string =>
    typeof value === "string" && validRange(value) !== null;
  for (const [file, json] of manifests) {
    const manager = json["packageManager"];
    if (manager !== undefined && manager !== `bun@${policy.bun}`)
      add({
        file,
        rule: "bun-pins",
        key: "packageManager",
        value: manager,
        message: `packageManager Bun version must be ${policy.bun} (one exact release at or above the shared minimum, the same in every manifest), found ${JSON.stringify(manager)}`,
      });
    const checkEntries = (
      entries: unknown,
      scope: EntryScope,
      location?: { key: string; value: unknown },
    ) => {
      if (!record(entries)) return;
      for (const [name, raw] of Object.entries(entries)) {
        const value = resolve(file, name, raw);
        if (isTypescriptInstall(name, value)) {
          const message = typescriptEntryMessage({
            file,
            entries,
            name,
            raw,
            value,
            scope,
          });
          if (message !== undefined)
            add({
              file,
              rule: "typescript-layout",
              key: location?.key ?? name,
              value: location === undefined ? raw : location.value,
              message,
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
    for (const key of installSections) checkEntries(json[key], "install");
    if (record(json["peerDependencies"]))
      for (const [name, value] of Object.entries(json["peerDependencies"])) {
        const resolved = resolve(file, name, value);
        if (isTypescriptInstall(name, resolved) && !peerRange(resolved))
          checkEntries({ [name]: value }, "peer");
      }
    for (const source of catalogSources(json)) {
      checkEntries(source["catalog"], "catalog");
      if (!record(source["catalogs"])) continue;
      for (const catalog of Object.values(source["catalogs"]))
        checkEntries(catalog, "catalog");
    }
    const ownedNames = new Set([...pins.keys(), ...typescriptPackages]);
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
        if (version > pattern.lastIndexOf("/"))
          pattern = pattern.slice(0, version);
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
        let value = replacement;
        if (typeof replacement === "string" && replacement.startsWith("$")) {
          const reference = replacement.slice(1);
          value = resolutionDependencies[reference];
        }
        const location = { key: selector, value: replacement };
        const targets = [...ownedNames].filter((name) =>
          picomatch(pattern)(name),
        );
        for (const name of targets)
          checkEntries({ [name]: value }, "resolution", location);
        // Redirecting any other package to a compiler is a TypeScript install too.
        if (
          typescriptAliasVersion(value) !== undefined &&
          !targets.some((name) => isTypescriptInstall(name, value))
        )
          checkEntries({ [pattern]: value }, "resolution", location);
      }
    };
    checkResolutionMap(json["overrides"]);
    checkResolutionMap(json["resolutions"]);
    if (record(json["pnpm"])) checkResolutionMap(json["pnpm"]["overrides"]);
    const command = record(json["scripts"])
      ? json["scripts"]["typecheck"]
      : undefined;
    if (typeof command === "string")
      for (const words of compilerCommandSegments(command)) {
        if (!invokesCompiler(words)) continue;
        const normalized = words.join(" ");
        if (
          !words.some((word) => word === "(" || word === ")") &&
          shellSubstitutions(normalized).length === 0 &&
          (normalized === typecheckCommand ||
            normalized.startsWith(`${typecheckCommand} `))
        )
          continue;
        add({
          file,
          rule: "typescript-layout",
          key: "typecheck",
          value: command,
          message: `typecheck must run \`${typecheckCommand} --no-pretty --all --project=<tsconfig>\`, not a TypeScript compiler package`,
        });
        break;
      }
    if (record(json["peerDependencies"]))
      for (const [name, raw] of Object.entries(json["peerDependencies"])) {
        if (!typescriptPackages.has(name)) continue;
        const range = resolve(file, name, raw);
        if (!peerRange(range)) continue;
        // Peer ranges, exact versions included, state support: `typescript`
        // must cover the checker's release; the native package has none.
        const release = name === "typescript" ? policy.typescript : undefined;
        if (release === undefined) {
          add({
            file,
            rule: "typescript-layout",
            key: name,
            value: raw,
            message: typescriptMessage(name, range),
          });
          continue;
        }
        if (satisfies(release, range)) continue;
        add({
          file,
          rule: "typescript-layout",
          key: name,
          value: raw,
          message: `${name} peer support range must include ${release}, found ${range}`,
        });
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
  // An entry stays only while its workspace still installs the TypeScript
  // entry beside the dependency that needs it.
  const staleness = (entry: TypescriptAllowlistEntry) => {
    const file = workspaceManifest(entry.workspace);
    const json = manifests.get(file);
    if (json === undefined)
      return `${file} is missing or invalid; remove the entry`;
    const declares = (name: string) =>
      installSections.some((section) => {
        const entries = json[section];
        return record(entries) && Object.hasOwn(entries, name);
      });
    if (!declares(entry.name))
      return `${file} no longer declares ${entry.name} in dependencies, devDependencies or optionalDependencies; remove the entry`;
    if (entry.kind === "source-api") {
      for (const source of entry.sources) {
        let owner = path.posix.dirname(source);
        while (owner !== "." && !manifests.has(`${owner}/package.json`))
          owner = path.posix.dirname(owner);
        if (owner !== entry.workspace)
          return `${source} belongs to workspace ${owner}, not ${entry.workspace}`;
        const problem = sourceApiImportProblem({
          source,
          content: files[source],
          name: entry.name,
        });
        if (problem !== undefined) return `${source}: ${problem}`;
      }
      return undefined;
    }
    if (!declares(entry.dependency))
      return `${file} no longer depends on ${entry.dependency}; remove the entry and the ${entry.name} declaration, or name the dependency that still needs it`;
    return undefined;
  };
  for (const entry of typescriptAllowlist) {
    const stale = staleness(entry);
    if (stale === undefined) continue;
    const message = `typescriptAllowlist entry ${entry.name} ${entry.spec} for ${entry.workspace} is stale: ${stale}`;
    if (sources.has(allowlistFile))
      add({
        file: allowlistFile,
        rule: "typescript-layout",
        key: "workspace",
        value: entry.workspace,
        message,
      });
    else
      diagnostics.push({
        rule: "typescript-layout",
        path: allowlistFile,
        line: 1,
        message,
      });
  }
  return diagnostics;
};
