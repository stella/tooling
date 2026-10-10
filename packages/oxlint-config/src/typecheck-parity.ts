import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve, join, relative, dirname, basename } from "node:path";
import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";

export const fixtures = [
  {
    name: "module-detection",
    flags: ["noUnusedLocals"],
    files: { "input.ts": "const unused = 1;" },
    codes: [6133],
  },
  {
    name: "skip-declaration-check",
    flags: ["skipLibCheck"],
    files: { "input.d.ts": "export declare const value: MissingType;" },
    codes: [],
  },
  {
    name: "json-import",
    flags: ["resolveJsonModule"],
    files: {
      "data.json": '{ "name": "value" }',
      "input.ts":
        'import data from "./data.json"; export const value: string = data.name;',
    },
    codes: [],
  },
  {
    name: "interop-import",
    flags: ["esModuleInterop"],
    files: {
      "types.d.cts": "declare const value: string; export = value;",
      "input.ts":
        'import value from "./types.cjs"; export const result: string = value;',
    },
    codes: [],
  },
  {
    name: "valid-control",
    flags: [],
    files: { "input.ts": 'export const value: string = "correct";' },
    codes: [],
  },
  {
    name: "type-mismatch",
    flags: [],
    files: { "input.ts": 'export const value: number = "wrong";' },
    codes: [2322],
  },
  {
    name: "missing-property",
    flags: [],
    files: { "input.ts": "export const value: { name: string } = {};" },
    codes: [2741],
  },
  {
    name: "strict-null",
    flags: ["strictNullChecks"],
    files: { "input.ts": "export const value: string = null;" },
    codes: [2322],
  },
  {
    name: "unchecked-index",
    flags: ["noUncheckedIndexedAccess"],
    files: { "input.ts": 'export const value: string = ["value"][1];' },
    codes: [2322],
  },
  {
    name: "unused-local",
    flags: ["noUnusedLocals"],
    files: { "input.ts": "const unused = 1; export {};" },
    codes: [6133],
  },
  {
    name: "unused-parameter",
    flags: ["noUnusedParameters"],
    files: { "input.ts": "export const value = (unused: string) => 1;" },
    codes: [6133],
  },
  {
    name: "implicit-any",
    flags: ["noImplicitAny"],
    files: { "input.ts": "export const value = (input) => input;" },
    codes: [7006],
  },
  {
    name: "missing-import",
    flags: [],
    files: {
      "input.ts": 'import { value } from "./missing.js"; export { value };',
    },
    codes: [2307],
  },
  {
    name: "side-effect-import",
    flags: ["noUncheckedSideEffectImports"],
    files: { "input.ts": 'import "./missing.js";' },
    codes: [2882],
  },
  {
    name: "generic-constraint",
    flags: [],
    files: {
      "input.ts":
        "type Box<T extends string> = { value: T }; export type Value = Box<number>;",
    },
    codes: [2344],
  },
  {
    name: "exact-optional",
    flags: ["exactOptionalPropertyTypes"],
    files: {
      "input.ts":
        "export const value: { optional?: string } = { optional: undefined };",
    },
    codes: [2375],
  },
  {
    name: "fallthrough",
    flags: ["noFallthroughCasesInSwitch"],
    files: {
      "input.ts":
        "export const run = (value: number) => { switch (value) { case 0: value++; case 1: return value; default: return 0; } };",
    },
    codes: [7029],
  },
  {
    name: "implicit-override",
    flags: ["noImplicitOverride"],
    files: {
      "input.ts":
        "class Base { value = 1; } export class Child extends Base { value = 2; }",
    },
    codes: [4114],
  },
  {
    name: "implicit-return",
    flags: ["noImplicitReturns"],
    files: {
      "input.ts":
        "export const run = (value: boolean) => { if (value) return 1; };",
    },
    codes: [7030],
  },
  {
    name: "unknown-catch",
    flags: ["useUnknownInCatchVariables"],
    files: {
      "input.ts":
        "export const run = () => { try { return 1; } catch (error) { return error.message; } };",
    },
    codes: [18046],
  },
  {
    name: "index-property",
    flags: ["noPropertyAccessFromIndexSignature"],
    files: {
      "input.ts":
        "export const run = (value: Record<string, string>) => value.name;",
    },
    codes: [4111],
  },
  {
    name: "erasable-syntax",
    flags: ["erasableSyntaxOnly"],
    files: { "input.ts": "export enum Value { First }" },
    codes: [1294],
  },
  {
    name: "type-only-import",
    flags: ["verbatimModuleSyntax"],
    files: {
      "types.ts": "export type Value = string;",
      "input.ts":
        'import { Value } from "./types.js"; export const value: Value = "value";',
    },
    codes: [1484],
  },
  {
    name: "checked-javascript",
    flags: ["allowJs", "checkJs"],
    files: {
      "input.js": '/** @type {number} */\nexport const value = "wrong";',
    },
    codes: [2322],
  },
  {
    name: "strict-function",
    flags: ["strictFunctionTypes"],
    files: {
      "input.ts":
        "export const value: (input: string | number) => void = (input: string) => { input.toUpperCase(); };",
    },
    codes: [2322],
  },
  {
    name: "strict-initialization",
    flags: ["strictPropertyInitialization"],
    files: { "input.ts": "export class Value { name: string; }" },
    codes: [2564],
  },
  {
    name: "strict-bind",
    flags: ["strictBindCallApply"],
    files: {
      "input.ts":
        "const value = (input: string) => input; export const result = value.call(undefined, 1);",
    },
    codes: [2345],
  },
  {
    name: "implicit-this",
    flags: ["noImplicitThis"],
    files: { "input.ts": "export function value() { return this.name; }" },
    codes: [2683],
  },
  {
    name: "strict-iterator",
    flags: ["strictBuiltinIteratorReturn"],
    files: {
      "input.ts":
        'export const value: string = ["value"].values().next().value;',
    },
    codes: [2322],
  },
  {
    name: "always-strict",
    flags: ["alwaysStrict"],
    files: { "input.ts": "export const value = (eval: string) => eval;" },
    codes: [1215],
  },
  {
    name: "file-casing",
    flags: ["forceConsistentCasingInFileNames"],
    files: {
      "named.ts": 'export const name = "value";',
      "Named.ts": 'export const name = "value";',
      "input.ts":
        'import { name } from "./named.js"; import { name as other } from "./Named.js"; export const value = name + other;',
    },
    codes: [1149, 1261],
    anyCode: true,
  },
];
export const diagnosticCodes = (text: string) =>
  [
    ...new Set(
      [...text.matchAll(/(?:TS|(?:error|warning)\s+)(\d{4,5})/g)].map((match) =>
        Number(match.at(1)),
      ),
    ),
  ].sort((a, b) => a - b);

type DiagnosticCheckResult = { status: number | null; output: string };
type DiagnosticParityOptions = {
  expected: readonly number[];
  match: "all" | "any";
  baseline: DiagnosticCheckResult;
  candidate: DiagnosticCheckResult;
  repo?: string;
};
export const diagnosticParity = ({
  expected,
  match,
  baseline,
  candidate,
}: DiagnosticParityOptions) => {
  const tscCodes = diagnosticCodes(baseline.output);
  const bunCodes = diagnosticCodes(candidate.output);
  const seeded =
    match === "any"
      ? expected.some((code) => tscCodes.includes(code))
      : expected.every((code) => tscCodes.includes(code));
  const missing = tscCodes.filter((code) => !bunCodes.includes(code));
  const extra = bunCodes.filter((code) => !tscCodes.includes(code));
  const exitsMatch =
    expected.length === 0
      ? baseline.status === 0 &&
        candidate.status === 0 &&
        tscCodes.length === 0 &&
        bunCodes.length === 0
      : baseline.status !== null &&
        baseline.status !== 0 &&
        candidate.status !== null &&
        candidate.status !== 0;
  return {
    tscCodes,
    bunCodes,
    missing,
    extra,
    passed:
      seeded &&
      exitsMatch &&
      baseline.status === candidate.status &&
      missing.length === 0 &&
      extra.length === 0,
  };
};

const configurationDiagnostics = (output: string, repo: string) =>
  diagnosticSet(output, repo).filter(
    (diagnostic) =>
      /^(?:<config>:0:|.*\.json:[0-9]+:)(?:[56][0-9]{3}|1800[23]|2688)(?::|$)/.test(
        diagnostic,
      ) || /:1800[23](?::|$)/.test(diagnostic),
  );

export const fixtureParity = (options: DiagnosticParityOptions) => {
  const result = diagnosticParity(options);
  const { baseline, candidate, expected, match } = options;
  const identityParity = compareDiagnosticSets(
    {
      status: baseline.status,
      diagnostics: diagnosticSet(
        baseline.output,
        options.repo ?? process.cwd(),
      ),
    },
    {
      status: candidate.status,
      diagnostics: diagnosticSet(
        candidate.output,
        options.repo ?? process.cwd(),
      ),
    },
  );
  const configDiagnostics = [
    ...configurationDiagnostics(
      baseline.output,
      options.repo ?? process.cwd(),
    ).map((diagnostic) => `TypeScript: ${diagnostic}`),
    ...configurationDiagnostics(
      candidate.output,
      options.repo ?? process.cwd(),
    ).map((diagnostic) => `Bun: ${diagnostic}`),
  ];
  const active =
    expected.length > 0 &&
    (match === "any"
      ? expected.some((code) => result.tscCodes.includes(code))
      : expected.every((code) => result.tscCodes.includes(code)));
  const validExits =
    baseline.status !== null &&
    candidate.status !== null &&
    (result.tscCodes.length === 0
      ? baseline.status === 0
      : baseline.status !== 0) &&
    (result.bunCodes.length === 0
      ? candidate.status === 0
      : candidate.status !== 0);
  return {
    ...result,
    active,
    configurationDiagnostics: configDiagnostics,
    identityMissing: identityParity.missing,
    identityExtra: identityParity.extra,
    passed:
      configDiagnostics.length === 0 &&
      identityParity.passed &&
      validExits &&
      baseline.status === candidate.status &&
      result.missing.length === 0 &&
      result.extra.length === 0,
  };
};

export const fixtureRunPassed = (
  results: { active: boolean; passed: boolean }[],
) =>
  results.some(({ active }) => active) && results.every(({ passed }) => passed);

const diagnosticLocation = (file: string, repo: string) => {
  const normalized = file.replaceAll("\\", "/");
  const bundled = /^bundled:\/\/\/libs\/(lib\.[^/]+\.d\.ts)$/.exec(normalized);
  const installed =
    /(?:^|\/)node_modules\/(?:typescript|@typescript\/(?:native|typescript-[^/]+))\/(?:.*\/)?(lib\.[^/]+\.d\.ts)$/.exec(
      normalized,
    );
  const library = bundled?.at(1) ?? installed?.at(1);
  return library === undefined
    ? relative(repo, resolve(repo, file)).replaceAll("\\", "/")
    : `<lib>/${library}`;
};
const globalDiagnosticKey = (code: string, message: string) =>
  `<config>:0:${code}:${message.trim().replaceAll(/\s+/g, " ")}`;

export const diagnosticSet = (output: string, repo: string) => {
  const clean = stripVTControlCharacters(output);
  const diagnostics = new Set<string>();
  for (const block of clean.matchAll(/<error\b([^>]*)>([\s\S]*?)<\/error>/g)) {
    const attributes = new Map(
      [...(block.at(1) ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((match) => [
        match.at(1),
        match.at(2),
      ]),
    );
    const file = attributes.get("file");
    const row = attributes.get("line");
    const code = attributes.get("code");
    if (code === undefined || !/^TS\d+$/.test(code)) continue;
    if (file !== undefined && row !== undefined && row !== "0")
      diagnostics.add(
        `${diagnosticLocation(file, repo)}:${row}:${code.slice(2)}`,
      );
    else {
      const message =
        (block.at(2) ?? "").split(/<(?:source|related)\b/).at(0) ?? "";
      diagnostics.add(globalDiagnosticKey(code.slice(2), message));
    }
  }
  for (const line of clean.split("\n")) {
    if (line.startsWith("<error ")) continue;
    const match =
      /^(.*?)\((\d+),\d+\):\s*(?:error|warning) TS(\d+)/.exec(line) ??
      /^(.*?):(\d+):\d+:\s*(?:error|warning) (?:TS)?(\d+)/.exec(line);
    if (match) {
      const [, file = "", row = "", code = ""] = match;
      diagnostics.add(`${diagnosticLocation(file, repo)}:${row}:${code}`);
    } else {
      const global = /^(?:error|warning) TS(\d+):\s*(.*)/.exec(line);
      if (global)
        diagnostics.add(
          globalDiagnosticKey(global.at(1) ?? "", global.at(2) ?? ""),
        );
    }
  }
  return [...diagnostics].sort();
};

type DiagnosticSetResult = { status: number | null; diagnostics: string[] };
export const compareDiagnosticSets = (
  baseline: DiagnosticSetResult,
  candidate: DiagnosticSetResult,
) => {
  const missing = baseline.diagnostics.filter(
    (item) => !candidate.diagnostics.includes(item),
  );
  const extra = candidate.diagnostics.filter(
    (item) => !baseline.diagnostics.includes(item),
  );
  const valid = (result: DiagnosticSetResult) =>
    result.status !== null &&
    (result.diagnostics.length === 0
      ? result.status === 0
      : result.status !== 0);
  return {
    missing,
    extra,
    passed:
      valid(baseline) &&
      valid(candidate) &&
      baseline.status === candidate.status &&
      missing.length === 0 &&
      extra.length === 0,
  };
};

export const assertUnshadowedCheck = async (repo: string) => {
  const manifest: unknown = JSON.parse(
    await readFile(join(repo, "package.json"), "utf8"),
  );
  if (typeof manifest !== "object" || manifest === null)
    throw new Error("Invalid repository package.json");
  if (
    "scripts" in manifest &&
    typeof manifest.scripts === "object" &&
    manifest.scripts !== null &&
    "check" in manifest.scripts
  )
    throw new Error(
      'Repository package.json must not define a "check" script: it shadows Bun typechecking; rename that script before running parity',
    );
};

export const resolveCompiler = async (repo: string, policy: unknown) => {
  if (
    typeof policy !== "object" ||
    policy === null ||
    !("typescriptInstallLayouts" in policy) ||
    !Array.isArray(policy.typescriptInstallLayouts)
  )
    throw new Error("toolchain.json must define typescriptInstallLayouts");
  const manifest: unknown = JSON.parse(
    await readFile(join(repo, "package.json"), "utf8"),
  );
  if (typeof manifest !== "object" || manifest === null)
    throw new Error("Invalid repository package.json");
  const dependencies = new Map<string, unknown>();
  for (const key of ["dependencies", "devDependencies"]) {
    if (!(key in manifest)) continue;
    const section = Reflect.get(manifest, key);
    if (typeof section === "object" && section !== null)
      for (const [name, specifier] of Object.entries(section))
        dependencies.set(name, specifier);
  }
  const require = createRequire(join(repo, "package.json"));
  // Prefer the explicit split compiler over its compatibility installation.
  for (const layout of [...policy.typescriptInstallLayouts].reverse()) {
    if (
      typeof layout !== "object" ||
      layout === null ||
      !("compilerPackage" in layout) ||
      typeof layout.compilerPackage !== "string"
    )
      throw new Error("Invalid TypeScript install layout");
    if (!dependencies.has(layout.compilerPackage)) continue;
    const packagePath = require.resolve(
      `${layout.compilerPackage}/package.json`,
    );
    const installed: unknown = JSON.parse(await readFile(packagePath, "utf8"));
    if (
      typeof installed !== "object" ||
      installed === null ||
      !("bin" in installed) ||
      typeof installed.bin !== "object" ||
      installed.bin === null ||
      !("tsc" in installed.bin) ||
      typeof installed.bin.tsc !== "string"
    )
      throw new Error(`${layout.compilerPackage} must expose a tsc binary`);
    if (
      !("compilerSpecifier" in layout) ||
      typeof layout.compilerSpecifier !== "string"
    )
      throw new Error(
        "TypeScript install layout must define compilerSpecifier",
      );
    const expectedVersion = layout.compilerSpecifier.replace(
      /^npm:typescript@/,
      "",
    );
    if (!("version" in installed) || installed.version !== expectedVersion)
      throw new Error(
        `${layout.compilerPackage} must install TypeScript ${expectedVersion}`,
      );
    return resolve(packagePath, "..", installed.bin.tsc);
  }
  throw new Error(
    "Repository must declare a compiler from typescriptInstallLayouts",
  );
};

export const assertBunVersion = (bun: string, policy: unknown) => {
  if (
    typeof policy !== "object" ||
    policy === null ||
    !("bun" in policy) ||
    typeof policy.bun !== "string"
  )
    throw new Error("toolchain.json must define bun");
  const result = spawnSync(bun, ["--version"], { encoding: "utf8" });
  if (result.error) throw result.error;
  const installed = result.stdout.trim();
  if (result.status !== 0 || installed !== policy.bun)
    throw new Error(
      `Bun must be ${policy.bun}; selected runtime reports ${installed || "no version"}`,
    );
};

export const bunCheckArgs = (project?: string, build = false) => [
  "check",
  "--no-pretty",
  "--all",
  ...(build ? ["--build"] : []),
  ...(project === undefined ? [] : [`--project=${project}`]),
];

const canonicalOptions = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalOptions).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalOptions(Reflect.get(value, key))}`,
      )
      .join(",")}}`;
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  )
    throw new Error("Invalid effective compiler option");
  return JSON.stringify(value);
};

// Emit and build settings do not belong in diagnostic-only fixture projects.
const EMIT_ONLY_OPTIONS = new Set([
  "composite",
  "declaration",
  "declarationDir",
  "declarationMap",
  "emitDeclarationOnly",
  "outDir",
  "outFile",
  "rootDir",
  "sourceMap",
  "inlineSourceMap",
  "inlineSources",
  "incremental",
  "tsBuildInfoFile",
  "noEmitOnError",
  "importHelpers",
  "noEmitHelpers",
  "emitBOM",
  "mapRoot",
  "sourceRoot",
  "newLine",
  "preserveConstEnums",
  "removeComments",
  "stripInternal",
  "downlevelIteration",
  "isolatedDeclarations",
  "noEmit",
]);

type FixtureCompilerOptionsArgs = {
  compilerOptions: unknown;
  configPath: string;
};
const resolvedCompilerOptions = ({
  compilerOptions,
  configPath,
}: FixtureCompilerOptionsArgs) => {
  if (
    typeof compilerOptions !== "object" ||
    compilerOptions === null ||
    Array.isArray(compilerOptions)
  )
    throw new Error(`Invalid compiler options: ${configPath}`);
  const options: Record<string, unknown> = Object.fromEntries(
    Object.entries(compilerOptions),
  );
  const directory = dirname(configPath);
  let resolutionDirectory = directory;
  const absolutePaths = (value: unknown) => {
    if (
      !Array.isArray(value) ||
      !value.every((entry: unknown) => typeof entry === "string")
    )
      throw new Error(`Invalid compiler path option: ${configPath}`);
    return value.map((entry) => resolve(resolutionDirectory, entry));
  };
  for (const name of ["rootDirs", "typeRoots"])
    if (name in options) options[name] = absolutePaths(options[name]);
  if ("baseUrl" in options) {
    const baseUrl = options["baseUrl"];
    if (typeof baseUrl !== "string")
      throw new Error(`Invalid baseUrl: ${configPath}`);
    resolutionDirectory = resolve(directory, baseUrl);
    options["baseUrl"] = resolutionDirectory;
  }
  if ("paths" in options) {
    const paths = options["paths"];
    if (typeof paths !== "object" || paths === null || Array.isArray(paths))
      throw new Error(`Invalid paths: ${configPath}`);
    options["paths"] = Object.fromEntries(
      Object.entries(paths).map(([key, value]) => [key, absolutePaths(value)]),
    );
  }
  if (!("typeRoots" in options)) {
    const roots = [];
    for (let folder = directory; ; folder = dirname(folder)) {
      roots.push(join(folder, "node_modules/@types"));
      if (dirname(folder) === folder) break;
    }
    options["typeRoots"] = roots;
  }
  return options;
};

export const fixtureCompilerOptions = (args: FixtureCompilerOptionsArgs) => {
  const options = Object.fromEntries(
    Object.entries(resolvedCompilerOptions(args)).filter(
      ([name]) => !EMIT_ONLY_OPTIONS.has(name),
    ),
  );
  options["noEmit"] = true;
  return options;
};

type FixtureInputOptions = {
  files: readonly string[];
  compilerOptions: Record<string, unknown>;
};
export const fixtureInputs = ({
  files,
  compilerOptions,
}: FixtureInputOptions) => {
  const inputs = files.filter((file) => /\.(?:[cm]?[jt]sx?|json)$/.test(file));
  for (const input of inputs) {
    if (/\.[cm]?jsx?$/.test(input) && compilerOptions["allowJs"] !== true)
      return {
        status: "inapplicable",
        reason: `${input} requires allowJs`,
      } as const;
    if (
      input.endsWith(".json") &&
      compilerOptions["resolveJsonModule"] !== true
    )
      return {
        status: "inapplicable",
        reason: `${input} requires resolveJsonModule`,
      } as const;
  }
  return { status: "applicable", files: inputs } as const;
};

export const fixturePackageContext = (configPath: string) => {
  for (let folder = dirname(configPath); ; folder = dirname(folder)) {
    try {
      const manifest: unknown = JSON.parse(
        readFileSync(join(folder, "package.json"), "utf8"),
      );
      if (typeof manifest !== "object" || manifest === null)
        throw new Error(`Invalid package.json: ${folder}`);
      if (!("type" in manifest)) return {};
      if (manifest.type !== "module" && manifest.type !== "commonjs")
        throw new Error(`Invalid package type: ${folder}`);
      return { type: manifest.type };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
    if (dirname(folder) === folder) return {};
  }
};

type CompilerConfig = {
  path: string;
  compilerOptions: unknown;
  packageContext?: unknown;
};
export const groupCompilerConfigs = (configs: CompilerConfig[]) => {
  const groups = new Map<
    string,
    {
      path: string;
      projects: string[];
      compilerOptions: unknown;
      packageContext?: unknown;
    }
  >();
  for (const config of configs) {
    const key = canonicalOptions({
      compilerOptions: fixtureCompilerOptions({
        compilerOptions: config.compilerOptions,
        configPath: config.path,
      }),
      packageContext: config.packageContext ?? {},
    });
    const existing = groups.get(key);
    if (existing) existing.projects.push(config.path);
    else
      groups.set(key, {
        path: config.path,
        projects: [config.path],
        compilerOptions: config.compilerOptions,
        ...(config.packageContext === undefined
          ? {}
          : { packageContext: config.packageContext }),
      });
  }
  return [...groups.values()];
};

type DiscoverConfigGroupsOptions = { repo: string; compiler: string };
export const discoverConfigGroups = ({
  repo,
  compiler,
}: DiscoverConfigGroupsOptions) => {
  const configs: CompilerConfig[] = [];
  const visited = new Set<string>();
  const projects: {
    path: string;
    compilerOptions: unknown;
    files: string[];
    references: string[];
  }[] = [];
  let build = false;
  const visit = (project: string) => {
    const path = realpathSync(
      statSync(project).isDirectory()
        ? join(project, "tsconfig.json")
        : project,
    );
    if (visited.has(path)) return;
    visited.add(path);
    const result = spawnSync(
      process.execPath,
      [compiler, "--showConfig", "--project", path],
      { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    const config: unknown = JSON.parse(result.stdout);
    if (typeof config !== "object" || config === null)
      throw new Error(`Invalid resolved config: ${path}`);
    const references: unknown[] =
      "references" in config && Array.isArray(config.references)
        ? config.references
        : [];
    build ||= references.length > 0;
    const compilerOptions =
      "compilerOptions" in config ? config.compilerOptions : {};
    if (
      typeof compilerOptions !== "object" ||
      compilerOptions === null ||
      Array.isArray(compilerOptions)
    )
      throw new Error(`Invalid compiler options: ${path}`);
    const rawFiles: unknown = "files" in config ? config.files : [];
    if (!Array.isArray(rawFiles))
      throw new Error(`Invalid project files: ${path}`);
    const files = rawFiles.map((file: unknown) => {
      if (typeof file !== "string")
        throw new Error(`Invalid project file: ${path}`);
      return resolve(dirname(path), file);
    });
    const referencePaths: string[] = [];
    projects.push({ path, compilerOptions, files, references: referencePaths });
    if (files.length > 0 || references.length === 0)
      configs.push({
        path,
        compilerOptions,
        packageContext: fixturePackageContext(path),
      });
    for (const reference of references) {
      if (
        typeof reference !== "object" ||
        reference === null ||
        !("path" in reference) ||
        typeof reference.path !== "string"
      )
        throw new Error(`Invalid project reference: ${path}`);
      const project = resolve(dirname(path), reference.path);
      const referencePath = realpathSync(
        statSync(project).isDirectory()
          ? join(project, "tsconfig.json")
          : project,
      );
      referencePaths.push(referencePath);
      visit(referencePath);
    }
  };
  visit(join(repo, "tsconfig.json"));
  const groups = groupCompilerConfigs(configs);
  if (groups.length === 0)
    throw new Error("No consumer compiler configurations to compare");
  return { build, groups, projects };
};

type TimedCommandOptions = { command: string; args: string[]; repo: string };
const timedCommand = ({ command, args, repo }: TimedCommandOptions) => {
  const started = performance.now();
  const timerFlag = process.platform === "darwin" ? "-l" : "-v";
  const result = spawnSync("/usr/bin/time", [timerFlag, command, ...args], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const rss =
    process.platform === "darwin"
      ? /([0-9]+)\s+maximum resident set size/.exec(result.stderr)
      : /Maximum resident set size \(kbytes\):\s*([0-9]+)/.exec(result.stderr);
  if (!rss) throw new Error("Cannot measure maximum RSS with /usr/bin/time");
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    wall: (performance.now() - started) / 1000,
    maxRssKiB: Number(rss[1]) / (process.platform === "darwin" ? 1024 : 1),
  };
};

const NO_WORK_MAX_RSS_KIB = 16 * 1024;
const NO_WORK_MAX_WALL_SECONDS = 0.25;

type SourceDiagnosticSetOptions = {
  output: string;
  repo: string;
  scratch: string;
  configPaths: readonly string[];
};
export const sourceDiagnosticSet = ({
  output,
  repo,
  scratch,
  configPaths,
}: SourceDiagnosticSetOptions) => {
  const configs = new Set(configPaths.map((path) => resolve(path)));
  return diagnosticSet(output, repo).filter((diagnostic) => {
    if (diagnostic.startsWith("<config>:")) return true;
    const file = /^(.*):[0-9]+:[0-9]+$/.exec(diagnostic)?.at(1);
    if (file === undefined) return false;
    const path = resolve(repo, file);
    return (
      !configs.has(path) && path !== scratch && !path.startsWith(scratch + "/")
    );
  });
};

type CompareRepositoryArgs = {
  repo: string;
  compiler: string;
  bun: string;
  graph: ReturnType<typeof discoverConfigGroups>;
};

type RepositoryDiagnosticComparisonOptions = {
  baseline: { status: number | null; output: string };
  candidate: { status: number | null; output: string };
  repo: string;
  scratch: string;
  configPaths: readonly string[];
};
export const repositoryDiagnosticComparison = ({
  baseline,
  candidate,
  repo,
  scratch,
  configPaths,
}: RepositoryDiagnosticComparisonOptions) => {
  const configs = new Set(configPaths.map((path) => resolve(path)));
  const configurationErrors = (output: string) => [
    ...new Set([
      ...configurationDiagnostics(output, repo),
      ...diagnosticSet(output, repo).filter((diagnostic) => {
        const file = /^(.*):[0-9]+:[0-9]+$/.exec(diagnostic)?.at(1);
        return file !== undefined && configs.has(resolve(repo, file));
      }),
    ]),
  ];
  const configurationErrorsFound = [
    ...configurationErrors(baseline.output).map(
      (diagnostic) => `TypeScript: ${diagnostic}`,
    ),
    ...configurationErrors(candidate.output).map(
      (diagnostic) => `Bun: ${diagnostic}`,
    ),
  ];
  const diagnostics = (output: string) =>
    sourceDiagnosticSet({ output, repo, scratch, configPaths });
  const comparison = compareDiagnosticSets(
    { status: baseline.status, diagnostics: diagnostics(baseline.output) },
    { status: candidate.status, diagnostics: diagnostics(candidate.output) },
  );
  return {
    ...comparison,
    passed: configurationErrorsFound.length === 0 && comparison.passed,
    configurationDiagnostics: configurationErrorsFound,
  };
};

export const compareRepository = async ({
  repo,
  compiler,
  bun,
  graph,
}: CompareRepositoryArgs) => {
  const scratch = await mkdtemp(join(tmpdir(), "parity-repository-"));
  try {
    const configPaths = new Map(
      graph.projects.map((project) => [
        project.path,
        join(scratch, "projects", relative(resolve("/"), project.path)),
      ]),
    );
    const linkedFolders = new Set<string>();
    for (const project of graph.projects) {
      const configPath = configPaths.get(project.path);
      if (configPath === undefined)
        throw new Error(`Missing temporary project: ${project.path}`);
      const folder = dirname(configPath);
      const outputFolder = join(
        folder,
        `${basename(configPath)}.parity-output`,
      );
      await mkdir(folder, { recursive: true });
      for (
        let original = dirname(project.path);
        ;
        original = dirname(original)
      ) {
        if (!linkedFolders.has(original)) {
          linkedFolders.add(original);
          const modules = join(original, "node_modules");
          try {
            if (statSync(modules).isDirectory()) {
              const destination = join(
                scratch,
                "projects",
                relative(resolve("/"), original),
              );
              await mkdir(destination, { recursive: true });
              await symlink(modules, join(destination, "node_modules"), "dir");
            }
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              error.code !== "ENOENT"
            )
              throw error;
          }
        }
        if (dirname(original) === original) break;
      }
      const options = resolvedCompilerOptions({
        configPath: project.path,
        compilerOptions: project.compilerOptions,
      });
      const rootDir = options["rootDir"];
      if (rootDir !== undefined && typeof rootDir !== "string")
        throw new Error(`Invalid rootDir: ${project.path}`);
      if (typeof rootDir === "string")
        options["rootDir"] = resolve(dirname(project.path), rootDir);
      else if (options["composite"] === true)
        options["rootDir"] = dirname(project.path);
      options["noEmit"] = !graph.build;
      options["outDir"] = join(outputFolder, "output");
      const emitsDeclarations =
        options["declaration"] === true ||
        (options["composite"] === true && options["declaration"] !== false);
      if ((graph.build && emitsDeclarations) || "declarationDir" in options)
        options["declarationDir"] = join(outputFolder, "declarations");
      if (
        graph.build ||
        options["incremental"] === true ||
        options["composite"] === true
      )
        options["tsBuildInfoFile"] = join(outputFolder, "project.tsbuildinfo");
      if (graph.build) {
        options["declarationMap"] = false;
        if (emitsDeclarations) options["emitDeclarationOnly"] = true;
        options["noEmitOnError"] = false;
      }
      delete options["outFile"];
      await writeFile(
        configPath,
        JSON.stringify({
          compilerOptions: options,
          files: project.files,
          include: [],
          references: project.references.map((path) => {
            const temporary = configPaths.get(path);
            if (temporary === undefined)
              throw new Error(`Missing referenced temporary project: ${path}`);
            return { path: temporary };
          }),
        }),
      );
    }
    const root = configPaths.get(realpathSync(join(repo, "tsconfig.json")));
    if (root === undefined) throw new Error("Missing temporary root config");
    const baselineRaw = timedCommand({
      command: process.execPath,
      args: [
        compiler,
        ...(graph.build
          ? ["--build", "--force", root]
          : ["--noEmit", "--project", root]),
        "--pretty",
        "false",
      ],
      repo,
    });
    const candidate = timedCommand({
      command: bun,
      args: bunCheckArgs(root, graph.build),
      repo,
    });
    const sourceDiagnostics = (output: string) =>
      sourceDiagnosticSet({
        output,
        repo,
        scratch,
        configPaths: graph.projects.map(({ path }) => path),
      });
    const baselineDiagnostics = sourceDiagnostics(baselineRaw.output);
    // TypeScript reports emitted-with-diagnostics as 2; Bun's checker reports diagnostics as 1.
    const baseline = {
      ...baselineRaw,
      rawStatus: baselineRaw.status,
      status:
        graph.build &&
        baselineRaw.status === 2 &&
        baselineDiagnostics.length > 0 &&
        configurationDiagnostics(baselineRaw.output, repo).length === 0
          ? 1
          : baselineRaw.status,
      diagnostics: baselineDiagnostics,
    };
    const repository = repositoryDiagnosticComparison({
      baseline,
      candidate,
      repo,
      scratch,
      configPaths: [
        ...graph.projects.map(({ path }) => path),
        ...configPaths.values(),
      ],
    });
    return {
      baseline,
      candidate: {
        ...candidate,
        rawStatus: candidate.status,
        diagnostics: sourceDiagnostics(candidate.output),
      },
      repository,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

type RunTypecheckParityOptions = {
  repo: string;
  policy: unknown;
  bun?: string;
};
export const runTypecheckParity = async ({
  repo,
  policy,
  bun = process.versions.bun ? process.execPath : "bun",
}: RunTypecheckParityOptions) => {
  await assertUnshadowedCheck(repo);
  assertBunVersion(bun, policy);
  const compiler = await resolveCompiler(repo, policy);
  const graph = discoverConfigGroups({ repo, compiler });
  const { groups } = graph;
  const { baseline, candidate, repository } = await compareRepository({
    repo,
    compiler,
    bun,
    graph,
  });
  console.log("Class | TypeScript diagnostics | Bun diagnostics | Result");
  console.log(
    `repository | ${baseline.diagnostics.join(",")} | ${candidate.diagnostics.join(",")} | ${repository.passed ? "PASS" : "FAIL"}`,
  );
  console.log(
    `repository tsc: wall=${baseline.wall.toFixed(3)}s maxRSS=${baseline.maxRssKiB}KiB exit=${baseline.rawStatus}`,
  );
  console.log(
    `repository bun: wall=${candidate.wall.toFixed(3)}s maxRSS=${candidate.maxRssKiB}KiB exit=${candidate.rawStatus}`,
  );
  for (const diagnostic of repository.configurationDiagnostics)
    console.error(`FAIL: invalid repository configuration: ${diagnostic}`);
  const scratch = await mkdtemp(join(tmpdir(), "typecheck-parity-"));
  const groupResults = [];
  try {
    await symlink(
      join(repo, "node_modules"),
      join(scratch, "node_modules"),
      "dir",
    );
    for (const [index, group] of groups.entries()) {
      console.log(
        `Config group ${index + 1}: ${relative(repo, group.path)} (${group.projects.length} projects)`,
      );
      const results = [];
      let tscWall = 0;
      let bunWall = 0;
      let tscRss = 0;
      let bunRss = 0;
      const groupFolder = join(scratch, `config-${index + 1}`);
      const compilerOptions = fixtureCompilerOptions({
        compilerOptions: group.compilerOptions,
        configPath: group.path,
      });
      await mkdir(groupFolder);
      await writeFile(
        join(groupFolder, "package.json"),
        JSON.stringify(
          group.packageContext ?? fixturePackageContext(group.path),
        ),
      );
      for (const fixture of fixtures) {
        const inputs = fixtureInputs({
          files: Object.keys(fixture.files),
          compilerOptions,
        });
        if (inputs.status === "inapplicable") {
          console.log(
            `${fixture.name} (inactive under this config: ${inputs.reason}) | | | INACTIVE`,
          );
          continue;
        }
        const folder = join(groupFolder, fixture.name);
        await mkdir(folder);
        await writeFile(
          join(folder, "tsconfig.json"),
          JSON.stringify({
            compilerOptions,
            files: inputs.files,
            include: [],
            exclude: [],
          }),
        );
        for (const [name, content] of Object.entries(fixture.files))
          await writeFile(join(folder, name), content);
        const tsc = timedCommand({
          command: process.execPath,
          args: [compiler, "--noEmit", "--pretty", "false", "-p", folder],
          repo: folder,
        });
        const checked = timedCommand({
          command: bun,
          args: [...bunCheckArgs(folder), "--threads=1"],
          repo: folder,
        });
        const result = fixtureParity({
          expected: fixture.codes,
          match: fixture.anyCode ? "any" : "all",
          repo: folder,
          baseline: tsc,
          candidate: checked,
        });
        results.push(result);
        tscWall += tsc.wall;
        bunWall += checked.wall;
        tscRss = Math.max(tscRss, tsc.maxRssKiB);
        bunRss = Math.max(bunRss, checked.maxRssKiB);
        if (result.configurationDiagnostics.length > 0) {
          console.error(
            `FAIL: invalid fixture configuration for ${fixture.name}: ${result.configurationDiagnostics.join("; ")}`,
          );
          console.log(
            `${fixture.name} | configuration error | configuration error | FAIL`,
          );
          continue;
        }
        let outcome = "INACTIVE";
        if (result.active) outcome = result.passed ? "PASS" : "FAIL";
        console.log(
          `${fixture.name}${result.active ? "" : " (inactive under this config)"} | ${result.tscCodes.join(",")} | ${result.bunCodes.join(",")} | ${outcome}`,
        );
        if (!result.active && !result.passed)
          console.error(
            `FAIL: diagnostic comparison differs for inactive class ${fixture.name}: TypeScript exit=${tsc.status}, Bun exit=${checked.status}; missing=${result.identityMissing.join(",")}; extra=${result.identityExtra.join(",")}`,
          );
        if (result.active && result.bunCodes.length === 0) {
          console.error(
            `FAIL: Bun returned zero diagnostics for active class ${fixture.name} (exit ${checked.status})`,
          );
          if (
            checked.maxRssKiB <= NO_WORK_MAX_RSS_KIB &&
            checked.wall <= NO_WORK_MAX_WALL_SECONDS
          )
            console.error(
              `Bun measured little checker work: wall=${checked.wall.toFixed(3)}s maxRSS=${checked.maxRssKiB}KiB; verify the checker invocation`,
            );
        }
      }
      console.log(
        `fixtures tsc: wall=${tscWall.toFixed(3)}s maxRSS=${tscRss}KiB`,
      );
      console.log(
        `fixtures bun: wall=${bunWall.toFixed(3)}s maxRSS=${bunRss}KiB`,
      );
      if (!results.some(({ active }) => active))
        console.error(
          `FAIL: zero seeded fixture classes active under config group ${index + 1}`,
        );
      groupResults.push(fixtureRunPassed(results));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return repository.passed && groupResults.every((passed) => passed);
};
