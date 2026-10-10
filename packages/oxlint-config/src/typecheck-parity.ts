import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve, join, relative } from "node:path";
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
  expected: number[];
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
    return resolve(packagePath, "..", installed.bin.tsc);
  }
  throw new Error(
    "Repository must declare a compiler from typescriptInstallLayouts",
  );
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

export const runTypecheckParity = async (repo: string, policy: unknown) => {
  const compiler = await resolveCompiler(repo, policy);
  const bun = process.versions.bun ? process.execPath : "bun";
  const baseline = timedCommand({
    command: process.execPath,
    args: [compiler, "--noEmit", "--pretty", "false"],
    repo,
  });
  const candidate = timedCommand({
    command: bun,
    args: ["check", "--no-pretty", "--all"],
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
  const results = [];
  let tscWall = 0;
  let bunWall = 0;
  let tscRss = 0;
  let bunRss = 0;
  try {
    for (const fixture of fixtures) {
      const folder = join(scratch, fixture.name);
      await mkdir(folder);
      await writeFile(
        join(folder, "tsconfig.json"),
        JSON.stringify({
          extends: join(repo, "tsconfig.json"),
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
        args: ["check", "--threads=1", "--no-pretty", "--all", "-p", folder],
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
        `${fixture.name}${result.active ? "" : " (inactive under this config)"} | ${result.tscCodes.join(",")} | ${result.bunCodes.join(",")} | ${result.passed ? "PASS" : "FAIL"}`,
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(`fixtures tsc: wall=${tscWall.toFixed(3)}s maxRSS=${tscRss}KiB`);
  console.log(`fixtures bun: wall=${bunWall.toFixed(3)}s maxRSS=${bunRss}KiB`);
  if (!results.some(({ active }) => active))
    console.error("FAIL: zero seeded fixture classes active under this config");
  return repository.passed && fixtureRunPassed(results);
};
