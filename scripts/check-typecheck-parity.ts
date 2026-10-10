import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

export const fixtures = [
  {
    name: "module-detection",
    flags: [],
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
    flags: ["strict"],
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
    flags: ["strict"],
    files: {
      "input.ts":
        "export const value: (input: string | number) => void = (input: string) => { input.toUpperCase(); };",
    },
    codes: [2322],
  },
  {
    name: "strict-initialization",
    flags: ["strict"],
    files: { "input.ts": "export class Value { name: string; }" },
    codes: [2564],
  },
  {
    name: "strict-bind",
    flags: ["strict"],
    files: {
      "input.ts":
        "const value = (input: string) => input; export const result = value.call(undefined, 1);",
    },
    codes: [2345],
  },
  {
    name: "implicit-this",
    flags: ["strict"],
    files: { "input.ts": "export function value() { return this.name; }" },
    codes: [2683],
  },
  {
    name: "strict-iterator",
    flags: ["strict"],
    files: {
      "input.ts":
        'export const value: string = ["value"].values().next().value;',
    },
    codes: [2322],
  },
  {
    name: "always-strict",
    flags: ["strict"],
    files: { "input.ts": "export const value = (eval: string) => eval;" },
    codes: [1215],
  },
  {
    name: "file-casing",
    flags: ["forceConsistentCasingInFileNames"],
    files: {
      "named.ts": 'export const name = "value";',
      "input.ts":
        'import { name } from "./named.js"; import { name as other } from "./Named.js"; export const value = name + other;',
    },
    codes: [1149, 1261, 2307],
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
    passed: seeded && exitsMatch && missing.length === 0,
  };
};

const run = async () => {
  const repo = resolve(process.argv[2] ?? ".");
  const bun = process.argv[3] ?? process.execPath;
  const output = process.argv[4];
  const basePath = join(repo, "packages/typescript-config/base.json");
  const base: unknown = JSON.parse(await readFile(basePath, "utf8"));
  if (
    !base ||
    typeof base !== "object" ||
    !("compilerOptions" in base) ||
    !base.compilerOptions ||
    typeof base.compilerOptions !== "object"
  )
    throw new Error("Invalid base config");
  const compilerOptions = base.compilerOptions;
  const coveredFlags = new Set(fixtures.flatMap(({ flags }) => flags));
  const nonDiagnosticFlags = new Set(["noEmit"]);
  for (const [flag, value] of Object.entries(compilerOptions)) {
    if (
      value === true &&
      !coveredFlags.has(flag) &&
      !nonDiagnosticFlags.has(flag)
    )
      throw new Error(`Uncovered enabled flag: ${flag}`);
  }
  const scratch = await mkdtemp(join(tmpdir(), "typecheck-parity-"));
  const results = [];

  try {
    for (const fixture of fixtures) {
      const folder = join(scratch, fixture.name);
      await mkdir(folder);
      await writeFile(
        join(folder, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { ...compilerOptions, types: [] },
          include: ["*.ts", "*.js", "*.cts"],
        }),
      );
      for (const [name, content] of Object.entries(fixture.files))
        if (content !== undefined) await writeFile(join(folder, name), content);
      const tsc = spawnSync(
        bun,
        [
          join(repo, "node_modules/typescript/bin/tsc"),
          "--noEmit",
          "--pretty",
          "false",
          "-p",
          folder,
        ],
        { encoding: "utf8" },
      );
      if (tsc.error) throw tsc.error;
      const checked = spawnSync(
        bun,
        ["check", "--threads=1", "--no-pretty", "--all", "-p", folder],
        { encoding: "utf8" },
      );
      if (checked.error) throw checked.error;
      const tscOutput = tsc.stdout + tsc.stderr;
      const bunOutput = checked.stdout + checked.stderr;
      const { tscCodes, bunCodes, missing, passed } = diagnosticParity({
        expected: fixture.codes,
        match: fixture.anyCode ? "any" : "all",
        baseline: { status: tsc.status, output: tscOutput },
        candidate: { status: checked.status, output: bunOutput },
      });
      results.push({
        name: fixture.name,
        flags: fixture.flags,
        expected: fixture.codes,
        tscCodes,
        bunCodes,
        missing,
        passed,
        tscExit: tsc.status,
        bunExit: checked.status,
        tscOutput,
        bunOutput,
      });
      console.log(
        `${passed ? "PASS" : "FAIL"} ${fixture.name}: tsc=${tscCodes.join(",")} bun=${bunCodes.join(",")} missing=${missing.join(",")}`,
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const report = {
    generatedAt: new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Prague",
      dateStyle: "short",
      timeStyle: "long",
    }).format(new Date()),
    repo,
    bun,
    coveredFlags: [...coveredFlags].sort(),
    nonDiagnosticFlags: [...nonDiagnosticFlags].sort(),
    results,
  };
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  if (results.some(({ passed }) => !passed)) process.exitCode = 1;
};

if (import.meta.main) await run();
