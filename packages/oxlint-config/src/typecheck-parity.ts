import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve, join, relative, dirname, basename } from "node:path";
import { performance } from "node:perf_hooks";

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

export const fixtureParity = (options: DiagnosticParityOptions) => {
  const result = diagnosticParity(options);
  const { baseline, candidate, expected, match } = options;
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
    passed:
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

export const diagnosticSet = (output: string, repo: string) => {
  const clean = output.replaceAll(/\u001b\[[0-9;]*m/g, "");
  const diagnostics = new Set<string>();
  for (const line of clean.split("\n")) {
    if (line.startsWith("<error ")) {
      const openingTag = line.slice(0, line.indexOf(">") + 1);
      const attributes = new Map(
        [...openingTag.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [
          match.at(1),
          match.at(2),
        ]),
      );
      const file = attributes.get("file");
      const row = attributes.get("line");
      const code = attributes.get("code");
      if (
        file !== undefined &&
        row !== undefined &&
        code !== undefined &&
        /^TS\d+$/.test(code)
      )
        diagnostics.add(
          `${relative(repo, resolve(repo, file)).replaceAll("\\", "/")}:${row}:${code.slice(2)}`,
        );
      continue;
    }
    const match =
      /^(.*?)\((\d+),\d+\):\s*(?:error|warning) TS(\d+)/.exec(line) ??
      /^(.*?):(\d+):\d+:\s*(?:error|warning) (?:TS)?(\d+)/.exec(line);
    if (match) {
      const [, file = "", row = "", code = ""] = match;
      diagnostics.add(
        `${relative(repo, resolve(repo, file)).replaceAll("\\", "/")}:${row}:${code}`,
      );
    } else {
      const global = /^(?:error|warning) TS(\d+):/.exec(line);
      if (global) diagnostics.add(`<config>:0:${global[1]}`);
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

const buildInfoPath = ({ path, compilerOptions }: CompilerConfig) => {
  const options =
    typeof compilerOptions === "object" && compilerOptions !== null
      ? compilerOptions
      : {};
  const optionPath = (name: string) => {
    const value: unknown = Reflect.get(options, name);
    return typeof value === "string"
      ? resolve(dirname(path), value)
      : undefined;
  };
  const explicit = optionPath("tsBuildInfoFile");
  if (explicit !== undefined) return explicit;
  const outFile = optionPath("outFile");
  if (outFile !== undefined)
    return outFile.replace(/\.[^/.]+$/, "") + ".tsbuildinfo";
  const configStem = path.replace(/\.[^/.]+$/, "");
  const outDir = optionPath("outDir");
  const rootDir = optionPath("rootDir");
  const target =
    outDir === undefined
      ? configStem
      : join(
          outDir,
          rootDir === undefined
            ? basename(configStem)
            : relative(rootDir, configStem),
        );
  return target + ".tsbuildinfo";
};

type PreserveBuildInfoOptions = {
  paths: string[];
  run: () => ReturnType<typeof timedCommand>;
};
const preserveBuildInfo = async ({ paths, run }: PreserveBuildInfoOptions) => {
  const snapshots = await Promise.all(
    paths.map(async (path) => {
      try {
        return { path, content: await readFile(path) };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          throw error;
        return { path, content: undefined };
      }
    }),
  );
  try {
    return run();
  } finally {
    for (const { path, content } of snapshots) {
      if (content === undefined) await rm(path, { force: true });
      else await writeFile(path, content);
    }
  }
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
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error("Invalid effective compiler option");
  return serialized;
};

type CompilerConfig = { path: string; compilerOptions: unknown };
export const groupCompilerConfigs = (configs: CompilerConfig[]) => {
  const groups = new Map<string, { path: string; projects: string[] }>();
  for (const config of configs) {
    const key = canonicalOptions(config.compilerOptions);
    const existing = groups.get(key);
    if (existing) existing.projects.push(config.path);
    else groups.set(key, { path: config.path, projects: [config.path] });
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
  const buildInfoPaths = new Set<string>();
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
    buildInfoPaths.add(
      buildInfoPath({
        path,
        compilerOptions:
          "compilerOptions" in config ? config.compilerOptions : {},
      }),
    );
    const hasFiles =
      "files" in config &&
      Array.isArray(config.files) &&
      config.files.length > 0;
    if (hasFiles || references.length === 0) {
      const compilerOptions =
        "compilerOptions" in config ? config.compilerOptions : {};
      if (
        typeof compilerOptions !== "object" ||
        compilerOptions === null ||
        Array.isArray(compilerOptions)
      )
        throw new Error(`Invalid compiler options: ${path}`);
      configs.push({ path, compilerOptions });
    }
    for (const reference of references) {
      if (
        typeof reference !== "object" ||
        reference === null ||
        !("path" in reference) ||
        typeof reference.path !== "string"
      )
        throw new Error(`Invalid project reference: ${path}`);
      visit(resolve(dirname(path), reference.path));
    }
  };
  visit(join(repo, "tsconfig.json"));
  const groups = groupCompilerConfigs(configs);
  if (groups.length === 0)
    throw new Error("No consumer compiler configurations to compare");
  return { build, groups, buildInfoPaths: [...buildInfoPaths] };
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
  const { build, groups, buildInfoPaths } = discoverConfigGroups({
    repo,
    compiler,
  });
  const baseline = await preserveBuildInfo({
    paths: buildInfoPaths,
    run: () =>
      timedCommand({
        command: process.execPath,
        args: [
          compiler,
          ...(build ? ["--build", "--force"] : []),
          "--noEmit",
          "--pretty",
          "false",
        ],
        repo,
      }),
  });
  const candidate = timedCommand({
    command: bun,
    args: bunCheckArgs(undefined, build),
    repo,
  });
  const repository = compareDiagnosticSets(
    {
      status: baseline.status,
      diagnostics: diagnosticSet(baseline.output, repo),
    },
    {
      status: candidate.status,
      diagnostics: diagnosticSet(candidate.output, repo),
    },
  );
  console.log("Class | TypeScript diagnostics | Bun diagnostics | Result");
  console.log(
    `repository | ${diagnosticSet(baseline.output, repo).join(",")} | ${diagnosticSet(candidate.output, repo).join(",")} | ${repository.passed ? "PASS" : "FAIL"}`,
  );
  console.log(
    `repository tsc: wall=${baseline.wall.toFixed(3)}s maxRSS=${baseline.maxRssKiB}KiB`,
  );
  console.log(
    `repository bun: wall=${candidate.wall.toFixed(3)}s maxRSS=${candidate.maxRssKiB}KiB`,
  );
  const scratch = await mkdtemp(join(tmpdir(), "typecheck-parity-"));
  const groupResults = [];
  try {
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
      await mkdir(groupFolder);
      for (const fixture of fixtures) {
        const folder = join(groupFolder, fixture.name);
        await mkdir(folder);
        await writeFile(
          join(folder, "tsconfig.json"),
          JSON.stringify({
            extends: group.path,
            compilerOptions: {
              types: [],
              composite: false,
              incremental: true,
              noEmit: true,
              rootDir: ".",
              outDir: "./output",
              tsBuildInfoFile: "./output/fixture.tsbuildinfo",
            },
            files: [],
            include: ["*.ts", "*.js", "*.cts"],
            exclude: [],
          }),
        );
        for (const [name, content] of Object.entries(fixture.files))
          await writeFile(join(folder, name), content);
        const tsc = timedCommand({
          command: process.execPath,
          args: [compiler, "--noEmit", "--pretty", "false", "-p", folder],
          repo,
        });
        const checked = timedCommand({
          command: bun,
          args: [...bunCheckArgs(folder), "--threads=1"],
          repo,
        });
        const result = fixtureParity({
          expected: fixture.codes,
          match: fixture.anyCode ? "any" : "all",
          baseline: tsc,
          candidate: checked,
        });
        results.push(result);
        tscWall += tsc.wall;
        bunWall += checked.wall;
        tscRss = Math.max(tscRss, tsc.maxRssKiB);
        bunRss = Math.max(bunRss, checked.maxRssKiB);
        console.log(
          `${fixture.name}${result.active ? "" : " (inactive under this config)"} | ${result.tscCodes.join(",")} | ${result.bunCodes.join(",")} | ${result.active ? (result.passed ? "PASS" : "FAIL") : "INACTIVE"}`,
        );
        if (!result.active && !result.passed)
          console.error(
            `FAIL: diagnostic comparison differs for inactive class ${fixture.name}`,
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
