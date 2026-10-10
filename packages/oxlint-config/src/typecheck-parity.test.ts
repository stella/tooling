/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertUnshadowedCheck,
  assertBunVersion,
  compareDiagnosticSets,
  diagnosticCodes,
  diagnosticSet,
  fixtureParity as compareFixtureParity,
  fixtureCompilerOptions,
  fixtureInputs,
  fixtureRunPassed,
  groupCompilerConfigs,
  diagnosticParity,
  fixtures,
  resolveCompiler,
  sourceDiagnosticSet,
  repositoryDiagnosticComparison,
  diagnosticExitStatus,
} from "./typecheck-parity";

const repo = resolve("/consumer-repo");

const fixtureParity = (
  options: Omit<Parameters<typeof compareFixtureParity>[0], "seedFiles">,
) => compareFixtureParity({ ...options, seedFiles: ["input.ts"] });

test("ambient diagnostics cannot activate a disabled seed or defeat the vacuous guard", () => {
  const ambient =
    "node_modules/ambient/index.d.ts(1,1): error TS2322: Ambient mismatch.";
  const seed = "input.ts(1,1): error TS2322: Seeded mismatch.";
  const check = { status: 1, output: ambient };
  const inactive = fixtureParity({
    repo,
    expected: [2322],
    match: "all",
    baseline: check,
    candidate: check,
  });
  expect(inactive.passed).toBe(true);
  expect(inactive.active).toBe(false);
  expect(fixtureRunPassed([inactive])).toBe(false);
  const baseline = { status: 1, output: ambient + "\n" + seed };
  const active = fixtureParity({
    repo,
    expected: [2322],
    match: "all",
    baseline,
    candidate: baseline,
  });
  expect(active.active).toBe(true);
  expect(active.passed).toBe(true);
  expect(
    fixtureParity({
      repo,
      expected: [2322],
      match: "all",
      baseline,
      candidate: check,
    }).passed,
  ).toBe(false);
});

test("temporary options preserve implicit package type resolution", () => {
  const options = fixtureCompilerOptions({
    configPath: join(repo, "workspace/tsconfig.json"),
    compilerOptions: { types: ["bun-types", "workspace-types"] },
  });
  expect("typeRoots" in options).toBe(false);
  expect(options["types"]).toEqual(["bun-types", "workspace-types"]);
});

test("diagnostic exit normalization preserves configuration and unknown failures", () => {
  const source = "input.d.ts(1,1): error TS2304: Missing name.";
  expect(diagnosticExitStatus({ status: 2, output: source, repo })).toBe(1);
  for (const status of [null, 0, 1, 3])
    expect(diagnosticExitStatus({ status, output: source, repo })).toBe(status);
  expect(diagnosticExitStatus({ status: 2, output: "", repo })).toBe(2);
  expect(
    diagnosticExitStatus({
      status: 2,
      output: source + "\nerror TS2688: Missing types.",
      repo,
    }),
  ).toBe(2);
});

test("repository parity rejects config diagnostics before source filtering in either direction", () => {
  const source = "src/input.ts(1,1): error TS2322: Type mismatch.";
  for (const configError of [
    "/scratch/project/tsconfig.json(2,1): error TS5069: Invalid declarationDir.",
    "/scratch/project/tsconfig.json(2,1): error TS2688: Missing types.",
    "error TS2688: Cannot find type definition file for bun-types.",
  ]) {
    for (const candidateHasError of [false, true]) {
      const clean = { status: 1, output: source };
      const invalid = { status: 1, output: source + "\n" + configError };
      const result = repositoryDiagnosticComparison({
        baseline: candidateHasError ? clean : invalid,
        candidate: candidateHasError ? invalid : clean,
        repo,
        scratch: "/scratch",
        configPaths: ["/scratch/project/tsconfig.json"],
      });
      expect(result.passed).toBe(false);
      expect(result.configurationDiagnostics.length).toBeGreaterThan(0);
      expect(result.missing).toEqual([]);
      expect(result.extra).toEqual([]);
    }
  }
});

test("fixture inputs reject inadmissible source kinds before compiler execution", () => {
  for (const files of [
    ["input.js"],
    ["input.jsx"],
    ["input.mjs"],
    ["input.cjs"],
    ["input.json"],
  ]) {
    for (const enabled of [undefined, false, true]) {
      const option = files[0]?.endsWith(".json")
        ? "resolveJsonModule"
        : "allowJs";
      const compilerOptions =
        enabled === undefined ? {} : { [option]: enabled };
      const result = fixtureInputs({ files, compilerOptions });
      expect(result.status).toBe(
        enabled === true ? "applicable" : "inapplicable",
      );
    }
  }
  expect(
    fixtureInputs({
      files: ["input.ts", "input.tsx", "package.json"],
      compilerOptions: { resolveJsonModule: true },
    }).status,
  ).toBe("applicable");
});

const rejectedError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Promise rejected without an Error");
  }
  throw new Error("Expected promise to reject");
};

test("compiler config grouping ignores property order but preserves option differences", () => {
  const entries = [
    {
      path: "/repo/strict/tsconfig.json",
      compilerOptions: { strict: true, paths: { second: ["b"], first: ["a"] } },
    },
    {
      path: "/repo/strict/tsconfig.same.json",
      compilerOptions: { paths: { first: ["a"], second: ["b"] }, strict: true },
    },
    {
      path: "/repo/loose/tsconfig.json",
      compilerOptions: {
        strict: false,
        paths: { first: ["a"], second: ["b"] },
      },
    },
    {
      path: "/repo/other-paths/tsconfig.json",
      compilerOptions: {
        strict: true,
        paths: { first: ["different"], second: ["b"] },
      },
    },
  ] as const;
  expect(groupCompilerConfigs([...entries])).toEqual([
    {
      compilerOptions: entries[0].compilerOptions,
      path: entries[0].path,
      projects: [entries[0].path, entries[1].path],
    },
    {
      compilerOptions: entries[2].compilerOptions,
      path: entries[2].path,
      projects: [entries[2].path],
    },
    {
      compilerOptions: entries[3].compilerOptions,
      path: entries[3].path,
      projects: [entries[3].path],
    },
  ]);
});

test("fixture compiler options drop emit constraints while preserving checking and resolution", () => {
  const retained = {
    strictNullChecks: true,
    noUncheckedIndexedAccess: true,
    isolatedModules: true,
    verbatimModuleSyntax: true,
    rewriteRelativeImportExtensions: true,
    types: ["custom"],
    futureCheckingOption: true,
  };
  const emitted = {
    composite: true,
    declaration: true,
    declarationDir: "./declarations",
    declarationMap: true,
    emitDeclarationOnly: true,
    outDir: "./output",
    outFile: "./bundle.js",
    rootDir: "./src",
    sourceMap: true,
    inlineSourceMap: true,
    inlineSources: true,
    incremental: true,
    tsBuildInfoFile: "./build.tsbuildinfo",
    noEmitOnError: true,
    importHelpers: true,
    noEmitHelpers: true,
    emitBOM: true,
    mapRoot: "./maps",
    sourceRoot: "./src",
    newLine: "crlf",
    preserveConstEnums: true,
    removeComments: true,
    stripInternal: true,
    downlevelIteration: true,
    isolatedDeclarations: true,
    noEmit: false,
  };
  expect(
    fixtureCompilerOptions({
      configPath: "/repo/leaf/tsconfig.json",
      compilerOptions: {
        ...retained,
        ...emitted,
        paths: { "@/*": ["./src/*"] },
        rootDirs: ["./src"],
        typeRoots: ["./types"],
      },
    }),
  ).toEqual({
    ...retained,
    noEmit: true,
    paths: { "@/*": ["/repo/leaf/src/*"] },
    rootDirs: ["/repo/leaf/src"],
    typeRoots: ["/repo/leaf/types"],
  });
});

const compilerPolicy = {
  typescriptInstallLayouts: [
    {
      type: "direct",
      compilerPackage: "typescript",
      compilerSpecifier: "7.0.2",
    },
    {
      type: "split-compatibility",
      compilerPackage: "@typescript/native",
      compilerSpecifier: "npm:typescript@7.0.2",
    },
  ],
};

const compilerFixture = async (run: (root: string) => Promise<void>) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "parity-compiler-test-")),
  );
  try {
    for (const name of ["typescript", "@typescript/native"]) {
      const directory = join(root, "node_modules", name);
      await mkdir(join(directory, "bin"), { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name, version: "7.0.2", bin: { tsc: "bin/tsc.js" } }),
      );
      await writeFile(join(directory, "bin/tsc.js"), "process.exit(0);");
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("compiler resolution uses a declared direct installation", async () => {
  await compilerFixture(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "7.0.2" } }),
    );
    expect(await resolveCompiler(root, compilerPolicy)).toBe(
      join(root, "node_modules/typescript/bin/tsc.js"),
    );
  });
});

test("consumer check-script guard rejects shadowing before any command runs", async () => {
  await compilerFixture(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { check: "exit 42" } }),
    );
    let failure: unknown;
    try {
      await assertUnshadowedCheck(root);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) {
      expect(failure.message).toContain('must not define a "check" script');
    }
  });
});

test("consumer check-script guard permits other script names", async () => {
  await compilerFixture(async (root) => {
    for (const manifest of [
      {},
      { scripts: { typecheck: "bun check", build: "tsdown" } },
    ]) {
      await writeFile(join(root, "package.json"), JSON.stringify(manifest));
      await assertUnshadowedCheck(root);
    }
  });
});

test("selected Bun executable must match the policy version", async () => {
  await compilerFixture(async (root) => {
    const executable = join(root, "bun-version-fixture");
    await writeFile(
      executable,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.4.2; else exit 42; fi\n',
    );
    await chmod(executable, 0o755);
    expect(() => assertBunVersion(executable, { bun: "1.4.3" })).toThrow();
    expect(() => assertBunVersion(executable, { bun: "1.4.2" })).not.toThrow();
  });
});

test("compiler resolution prefers the split compiler to its compatibility dependency", async () => {
  await compilerFixture(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { typescript: "6.0.3" },
        devDependencies: { "@typescript/native": "npm:typescript@7.0.2" },
      }),
    );
    expect(await resolveCompiler(root, compilerPolicy)).toBe(
      join(root, "node_modules/@typescript/native/bin/tsc.js"),
    );
  });
});

test("compiler resolution rejects undeclared installed compilers", async () => {
  await compilerFixture(async (root) => {
    await writeFile(join(root, "package.json"), JSON.stringify({}));
    const error = await rejectedError(resolveCompiler(root, compilerPolicy));
    expect(error.message).toContain("Repository must declare a compiler");
  });
});

test("compiler resolution rejects installed version skew", async () => {
  await compilerFixture(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "7.0.2" } }),
    );
    await writeFile(
      join(root, "node_modules/typescript/package.json"),
      JSON.stringify({
        name: "typescript",
        version: "6.0.3",
        bin: { tsc: "bin/tsc.js" },
      }),
    );
    const error = await rejectedError(resolveCompiler(root, compilerPolicy));
    expect(error.message).toContain("must install TypeScript 7.0.2");
  });
});

test("compiler resolution rejects a selected package without a tsc bin", async () => {
  await compilerFixture(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "7.0.2" } }),
    );
    await writeFile(
      join(root, "node_modules/typescript/package.json"),
      JSON.stringify({ name: "typescript", version: "7.0.2", bin: {} }),
    );
    const error = await rejectedError(resolveCompiler(root, compilerPolicy));
    expect(error.message).toContain("must expose a tsc binary");
  });
});

test("the shipped fixture corpus contains all 31 distinct classes with source inputs", () => {
  expect(fixtures).toHaveLength(31);
  expect(new Set(fixtures.map(({ name }) => name)).size).toBe(31);
  for (const fixture of fixtures) {
    expect(Object.keys(fixture.files).length).toBeGreaterThan(0);
    expect(
      Object.values(fixture.files).every((source) => source.length > 0),
    ).toBe(true);
  }
});

test("diagnostic sets canonicalize TypeScript and Bun locations and ignore summaries", () => {
  const tsc = [
    "src/input.ts(4,7): error TS2322: wrong type",
    "src/other.ts(12,1): error TS7006: implicit any",
    "src/input.ts(4,18): error TS2322: repeated on the same line",
  ].join("\n");
  const bun = [
    `${repo}/src/other.ts(12,1): error TS7006: implicit any`,
    "./src/input.ts(4,7): error TS2322: wrong type",
    "Found 2 errors in 2 files, checked 17 files [24.24ms]",
  ].join("\n");
  const expected = ["src/input.ts:4:2322", "src/other.ts:12:7006"];
  expect(diagnosticSet(tsc, repo)).toEqual(expected);
  expect(diagnosticSet(bun, repo)).toEqual(expected);
  expect(
    diagnosticSet(
      "\u001b[31msrc/input.ts:4:7: error TS2322: wrong type\u001b[0m",
      repo,
    ),
  ).toEqual(["src/input.ts:4:2322"]);
});

test("tagged agent diagnostics retain primary location independent of attribute order", () => {
  expect(
    diagnosticSet(
      '<error file="src/index.ts" line="3" column="25" code="TS2322">\nwrong type\n<source>const x = 1;</source><related file="src/user.ts" line="2" column="3">related</related></error>\n<error code="TS7006" column="1" line="9" file="src/other.ts">implicit any</error>',
      repo,
    ),
  ).toEqual(["src/index.ts:3:2322", "src/other.ts:9:7006"]);
});

test("diagnostic sets preserve file, line and code independently", () => {
  expect(
    diagnosticSet(
      [
        "src/other.ts(4,1): error TS2322: same code, different file",
        "src/input.ts(5,1): error TS2322: same code, different line",
        "src/input.ts(4,1): error TS7006: same location, different code",
        "src/input.ts(4,1): error TS2322: original error",
      ].join("\n"),
      repo,
    ),
  ).toEqual([
    "src/input.ts:4:2322",
    "src/input.ts:4:7006",
    "src/input.ts:5:2322",
    "src/other.ts:4:2322",
  ]);
});

test("configuration diagnostics remain visible without a source location", () => {
  expect(
    diagnosticSet(
      "error TS5083: Cannot read configuration file.\nerror TS18003: No inputs were found.\n",
      repo,
    ),
  ).toEqual([
    "<config>:0:18003:No inputs were found.",
    "<config>:0:5083:Cannot read configuration file.",
  ]);
});

test("standard library diagnostics share an identity across installed and bundled libraries", () => {
  const expected = ["<lib>/lib.es5.d.ts:42:2322"];
  const tsc = `${repo}/node_modules/typescript/lib/lib.es5.d.ts(42,7): error TS2322: library error`;
  const bun = "bundled:///libs/lib.es5.d.ts:42:7: error TS2322: library error";
  expect(diagnosticSet(tsc, repo)).toEqual(expected);
  expect(diagnosticSet(bun, repo)).toEqual(expected);
  expect(
    diagnosticSet(
      '<error file="bundled:///libs/lib.es5.d.ts" line="42" column="7" code="TS2322">library error</error>',
      repo,
    ),
  ).toEqual(expected);
  expect(
    fixtureParity({
      repo,
      expected: [2322],
      match: "all",
      baseline: { status: 1, output: tsc },
      candidate: { status: 1, output: bun },
    }).passed,
  ).toBe(true);
});

test("locationless diagnostics preserve distinct normalized messages and deduplicate repeats", () => {
  expect(
    diagnosticSet(
      [
        "error TS2318: Cannot find global type 'Array'.",
        "error TS2318: Cannot find global type 'Boolean'.",
        "error TS2318:   Cannot   find global type 'Array'.  ",
      ].join("\n"),
      repo,
    ),
  ).toEqual([
    "<config>:0:2318:Cannot find global type 'Array'.",
    "<config>:0:2318:Cannot find global type 'Boolean'.",
  ]);
});

test("fixture parity rejects missing or extra locations sharing an active diagnostic code", () => {
  const first = "input.ts(1,1): error TS2322: first mismatch";
  const second = "input.ts(2,1): error TS2322: second mismatch";
  const baseline = { status: 1, output: `${first}\n${second}` };
  const candidate = { status: 1, output: first };
  const options = { repo, expected: [2322], match: "all" } as const;
  const matching = fixtureParity({ ...options, baseline, candidate: baseline });
  expect(matching.active).toBe(true);
  expect(matching.passed).toBe(true);
  for (const [left, right] of [
    [baseline, candidate],
    [candidate, baseline],
  ]) {
    if (left === undefined || right === undefined)
      throw new Error("Missing result");
    const result = fixtureParity({
      ...options,
      baseline: left,
      candidate: right,
    });
    expect(result.active).toBe(true);
    expect(result.passed).toBe(false);
  }
});

test("fixture parity rejects lost global diagnostics with the same code", () => {
  const array = "error TS2318: Cannot find global type 'Array'.";
  const boolean = "error TS2318: Cannot find global type 'Boolean'.";
  const baseline = { status: 1, output: `${array}\n${boolean}` };
  const candidate = { status: 1, output: array };
  const options = { repo, expected: [2318], match: "all" } as const;
  expect(
    fixtureParity({ ...options, baseline, candidate: baseline }).passed,
  ).toBe(true);
  expect(fixtureParity({ ...options, baseline, candidate }).passed).toBe(false);
  expect(
    fixtureParity({ ...options, baseline: candidate, candidate: baseline })
      .passed,
  ).toBe(false);
});

test("repository parity rejects every removed or relocated diagnostic", () => {
  const diagnostics = [
    "src/input.ts:4:2322",
    "src/input.ts:5:2322",
    "src/other.ts:4:2322",
    "src/input.ts:4:7006",
  ];
  const baseline = { status: 1, diagnostics };
  expect(compareDiagnosticSets(baseline, baseline).passed).toBe(true);
  expect(
    compareDiagnosticSets(baseline, {
      status: 1,
      diagnostics: [...diagnostics].reverse(),
    }).passed,
  ).toBe(true);
  for (const removed of diagnostics) {
    const result = compareDiagnosticSets(baseline, {
      status: 1,
      diagnostics: diagnostics.filter((diagnostic) => diagnostic !== removed),
    });
    expect(result.missing).toEqual([removed]);
    expect(result.extra).toEqual([]);
    expect(result.passed).toBe(false);
    const relocated = `${removed}-changed`;
    const moved = compareDiagnosticSets(baseline, {
      status: 1,
      diagnostics: diagnostics.map((diagnostic) =>
        diagnostic === removed ? relocated : diagnostic,
      ),
    });
    expect(moved.missing).toEqual([removed]);
    expect(moved.extra).toEqual([relocated]);
    expect(moved.passed).toBe(false);
  }
});

test("repository parity rejects additional diagnostics and invalid process statuses", () => {
  const diagnostics = ["input.ts:1:2322"];
  const error = { status: 1, diagnostics };
  const clean = { status: 0, diagnostics: [] };
  expect(compareDiagnosticSets(clean, clean).passed).toBe(true);
  const extra = compareDiagnosticSets(error, {
    status: 1,
    diagnostics: [...diagnostics, "input.ts:2:7006"],
  });
  expect(extra.extra).toEqual(["input.ts:2:7006"]);
  expect(extra.passed).toBe(false);
  for (const invalid of [
    { status: null, diagnostics },
    { status: 0, diagnostics },
    { status: 1, diagnostics: [] },
  ]) {
    expect(compareDiagnosticSets(invalid, error).passed).toBe(false);
    expect(compareDiagnosticSets(error, invalid).passed).toBe(false);
    expect(compareDiagnosticSets(invalid, invalid).passed).toBe(false);
  }
  expect(compareDiagnosticSets(clean, error).passed).toBe(false);
  expect(compareDiagnosticSets(error, clean).passed).toBe(false);
});

test("diagnostic parsing retains codes independent of ordering, location and duplicate messages", () => {
  expect(
    diagnosticCodes(
      "input.ts(1,1): error TS2322: wrong\ninput.js:2:3: error TS7006: wrong\nerror TS2322: repeated",
    ),
  ).toEqual([2322, 7006]);
});

for (const fixture of fixtures) {
  test(`${fixture.name} runtime fixture comparison rejects every lost diagnostic`, () => {
    const output = fixture.codes
      .map((code) => `input.ts(1,1): error TS${code}: seeded diagnostic\n`)
      .join("");
    const status = fixture.codes.length === 0 ? 0 : 1;
    const baseline = { status, output };
    const options = {
      expected: fixture.codes,
      match: fixture.anyCode ? "any" : "all",
      baseline,
      candidate: baseline,
    } as const;
    expect(fixtureParity(options).passed).toBe(true);
    expect(fixtureParity(options).active).toBe(fixture.codes.length > 0);
    for (const code of diagnosticCodes(output)) {
      const result = fixtureParity({
        ...options,
        candidate: {
          status,
          output: output.replaceAll(new RegExp(`^.*TS${code}:.*$`, "gm"), ""),
        },
      });
      expect(result.missing).toEqual([code]);
      expect(result.passed).toBe(false);
    }
    for (const invalid of [
      { status: null, output },
      { status: 1, output: "" },
      { status: 1, output: "unsupported check command" },
    ]) {
      expect(fixtureParity({ ...options, baseline: invalid }).passed).toBe(
        false,
      );
      expect(fixtureParity({ ...options, candidate: invalid }).passed).toBe(
        false,
      );
    }
    if (fixture.codes.length > 0) {
      const disabled = fixtureParity({
        ...options,
        baseline: { status: 0, output: "" },
        candidate: { status: 0, output: "" },
      });
      expect(disabled.active).toBe(false);
      expect(disabled.passed).toBe(true);
    }
  });

  test(`${fixture.name} rejects removal of every expected diagnostic from candidate output`, () => {
    const output = fixture.codes
      .map((code) => `input.ts(1,1): error TS${code}: seeded diagnostic\n`)
      .join("");
    const status = fixture.codes.length === 0 ? 0 : 1;
    const baseline = { status, output };
    const options = {
      expected: fixture.codes,
      match: "all",
      baseline,
      candidate: baseline,
    } as const;
    expect(diagnosticParity(options).passed).toBe(true);
    for (const code of diagnosticCodes(output)) {
      const candidate = {
        status,
        output: output.replaceAll(new RegExp(`^.*TS${code}:.*$`, "gm"), ""),
      };
      const result = diagnosticParity({ ...options, candidate });
      expect(result.missing).toEqual([code]);
      expect(result.passed).toBe(false);
    }
    if (fixture.codes.length === 0) {
      expect(
        diagnosticParity({
          ...options,
          candidate: { status: 0, output: "error TS2322: unexpected" },
        }).passed,
      ).toBe(false);
    }
    expect(
      diagnosticParity({ ...options, baseline: { status: null, output } })
        .passed,
    ).toBe(false);
    expect(
      diagnosticParity({ ...options, candidate: { status: null, output } })
        .passed,
    ).toBe(false);
  });
}

test("inactive fixtures skip seed requirements while retaining diagnostic and exit checks", () => {
  const options = {
    expected: [2322],
    match: "all",
    baseline: { status: 0, output: "" },
    candidate: { status: 0, output: "" },
  } as const;
  expect(fixtureParity(options).passed).toBe(true);
  expect(fixtureParity(options).active).toBe(false);
  const unrelated = {
    status: 1,
    output: "input.ts(1,1): error TS7006: other flag",
  };
  expect(
    fixtureParity({ ...options, baseline: unrelated, candidate: unrelated })
      .passed,
  ).toBe(true);
  expect(fixtureParity({ ...options, baseline: unrelated }).passed).toBe(false);
  for (const invalid of [
    { status: null, output: "" },
    { status: 1, output: "" },
    { status: 0, output: unrelated.output },
  ]) {
    expect(fixtureParity({ ...options, baseline: invalid }).passed).toBe(false);
    expect(fixtureParity({ ...options, candidate: invalid }).passed).toBe(
      false,
    );
  }
});

test("fixture run rejects empty coverage and any failing class", () => {
  expect(fixtureRunPassed([])).toBe(false);
  expect(fixtureRunPassed([{ active: false, passed: true }])).toBe(false);
  expect(
    fixtureRunPassed([
      { active: false, passed: true },
      { active: true, passed: true },
    ]),
  ).toBe(true);
  expect(
    fixtureRunPassed([
      { active: false, passed: false },
      { active: true, passed: true },
    ]),
  ).toBe(false);
  expect(fixtureRunPassed([{ active: true, passed: false }])).toBe(false);
  const clean = { status: 0, output: "" };
  const inactiveCorpus = fixtures.map((fixture) =>
    fixtureParity({
      expected: fixture.codes,
      match: fixture.anyCode ? "any" : "all",
      baseline: clean,
      candidate: clean,
    }),
  );
  expect(inactiveCorpus).toHaveLength(31);
  expect(inactiveCorpus.every(({ active, passed }) => !active && passed)).toBe(
    true,
  );
  expect(fixtureRunPassed(inactiveCorpus)).toBe(false);
});

test("fixture activation follows all or any baseline expected diagnostics", () => {
  const first = { status: 1, output: "input.ts(1,1): error TS1149: casing" };
  for (const match of ["all", "any"] as const) {
    const result = fixtureParity({
      expected: [1149, 1261],
      match,
      baseline: first,
      candidate: first,
    });
    expect(result.active).toBe(match === "any");
    expect(result.passed).toBe(true);
  }
});

test("positive controls compare matching errors introduced by consumer compiler flags", () => {
  const unrelated = {
    status: 1,
    output: "input.ts(1,1): error TS7006: consumer flag",
  };
  const options = {
    expected: [],
    match: "all",
    baseline: unrelated,
    candidate: unrelated,
  } as const;
  expect(fixtureParity(options).passed).toBe(true);
  expect(
    fixtureParity({ ...options, candidate: { status: 0, output: "" } }).passed,
  ).toBe(false);
});

test("baseline must report the seeded error and fail the check", () => {
  const expected = [2322];
  const options = {
    expected,
    match: "all",
    baseline: { status: 1, output: "error TS2322: seeded error" },
    candidate: { status: 1, output: "error TS2322: seeded error" },
  } as const;
  for (const baseline of [
    { status: 1, output: "" },
    { status: 1, output: "error TS7006: unrelated error" },
    { status: 0, output: "error TS2322: seeded error" },
  ]) {
    expect(diagnosticParity({ ...options, baseline }).passed).toBe(false);
  }
  expect(
    diagnosticParity({
      ...options,
      candidate: { status: 1, output: "check: unsupported command" },
    }).passed,
  ).toBe(false);
});

test("alternative diagnostic classes accept each supported code and reject unrelated errors", () => {
  const expected = [1149, 1261];
  for (const code of expected) {
    const result = {
      status: 1,
      output: `error TS${code}: casing or import error`,
    };
    expect(
      diagnosticParity({
        expected,
        match: "any",
        baseline: result,
        candidate: result,
      }).passed,
    ).toBe(true);
  }
  for (const output of ["", "error TS7006: unrelated error"]) {
    const result = { status: 1, output };
    expect(
      diagnosticParity({
        expected,
        match: "any",
        baseline: result,
        candidate: result,
      }).passed,
    ).toBe(false);
  }
});

test("fixture parity rejects unexpected positive-control diagnostics in either direction", () => {
  const clean = { status: 0, output: "" };
  const error = {
    status: 1,
    output: "input.ts(1,1): error TS2322: unexpected",
  };
  for (const baselineStatus of [0, 1]) {
    const options = { expected: [], match: "all" } as const;
    expect(
      fixtureParity({
        ...options,
        baseline: { status: baselineStatus, output: "" },
        candidate: { status: 0, output: "" },
      }).passed,
    ).toBe(baselineStatus === 0);
    const extra = fixtureParity({
      ...options,
      baseline: clean,
      candidate: error,
    });
    expect(extra.extra).toEqual([2322]);
    expect(extra.passed).toBe(false);
    const missing = fixtureParity({
      ...options,
      baseline: error,
      candidate: clean,
    });
    expect(missing.missing).toEqual([2322]);
    expect(missing.passed).toBe(false);
  }
});

test("fixture parity rejects extra or missing codes even with equal failing statuses", () => {
  const baseline = { status: 1, output: "input.ts(1,1): error TS2322: seeded" };
  const extra = {
    status: 1,
    output: baseline.output + "\ninput.ts(2,1): error TS7006: extra",
  };
  const options = { expected: [2322], match: "all" } as const;
  expect(
    fixtureParity({ ...options, baseline, candidate: extra }).extra,
  ).toEqual([7006]);
  expect(fixtureParity({ ...options, baseline, candidate: extra }).passed).toBe(
    false,
  );
  expect(
    fixtureParity({ ...options, baseline: extra, candidate: baseline }).missing,
  ).toEqual([7006]);
  expect(
    fixtureParity({ ...options, baseline: extra, candidate: baseline }).passed,
  ).toBe(false);
  expect(
    diagnosticParity({ ...options, baseline, candidate: extra }).passed,
  ).toBe(false);
  expect(
    diagnosticParity({ ...options, baseline: extra, candidate: baseline })
      .passed,
  ).toBe(false);
});

test("equal diagnostic sets require equal exit statuses in both comparisons", () => {
  const baseline = { status: 1, output: "input.ts(1,1): error TS2322: seeded" };
  const candidate = { ...baseline, status: 2 };
  const options = { expected: [2322], match: "all" } as const;
  for (const [left, right] of [
    [baseline, candidate],
    [candidate, baseline],
  ]) {
    if (left === undefined || right === undefined)
      throw new Error("Missing result");
    expect(
      fixtureParity({ ...options, baseline: left, candidate: right }).passed,
    ).toBe(false);
    expect(
      diagnosticParity({ ...options, baseline: left, candidate: right }).passed,
    ).toBe(false);
    expect(
      compareDiagnosticSets(
        { status: left.status, diagnostics: ["input.ts:1:2322"] },
        { status: right.status, diagnostics: ["input.ts:1:2322"] },
      ).passed,
    ).toBe(false);
  }
});

test("tagged locationless diagnostics preserve normalized primary messages", () => {
  expect(
    diagnosticSet(
      "<error code=\"TS2318\">\nCannot find global type 'Array'.\n</error>\n<error code=\"TS2318\">Cannot find global type 'Boolean'.</error>",
      repo,
    ),
  ).toEqual([
    "<config>:0:2318:Cannot find global type 'Array'.",
    "<config>:0:2318:Cannot find global type 'Boolean'.",
  ]);
});

test("config grouping preserves distinct package module contexts", () => {
  const configs = [
    {
      path: "/repo/esm/tsconfig.json",
      compilerOptions: { module: "NodeNext" },
      packageContext: { type: "module" },
    },
    {
      path: "/repo/commonjs/tsconfig.json",
      compilerOptions: { module: "NodeNext" },
      packageContext: { type: "commonjs" },
    },
  ];
  expect(groupCompilerConfigs(configs).map(({ projects }) => projects)).toEqual(
    [["/repo/esm/tsconfig.json"], ["/repo/commonjs/tsconfig.json"]],
  );
});

test("config grouping preserves path-dependent ambient and alias resolution", () => {
  for (const compilerOptions of [
    { strict: true },
    {
      strict: true,
      paths: { "@/*": ["./src/*"] },
      typeRoots: ["/shared/types"],
    },
    { strict: true, rootDirs: ["./src"], typeRoots: ["/shared/types"] },
  ]) {
    const configs = ["first", "second"].map((name) => ({
      path: `/repo/${name}/tsconfig.json`,
      compilerOptions,
    }));
    expect(groupCompilerConfigs(configs).length).toBe(2);
  }
  const configs = ["first", "second"].map((name) => ({
    path: `/repo/${name}/tsconfig.json`,
    compilerOptions: { strict: true, typeRoots: ["/shared/types"] },
  }));
  expect(groupCompilerConfigs(configs).length).toBe(1);
});

test("repository source diagnostics preserve JSON and exclude generated outputs and configs", () => {
  const diagnostics = sourceDiagnosticSet({
    output: [
      "src/data.json(2,1): error TS1005: Expected comma.",
      "src/input.ts(1,1): error TS2322: Type mismatch.",
      "/scratch/project/output/input.d.ts(1,1): error TS2322: Generated.",
      "tsconfig.json(1,1): error TS5069: Invalid config.",
    ].join("\n"),
    repo,
    scratch: "/scratch",
    configPaths: [join(repo, "tsconfig.json")],
  });
  expect(diagnostics).toEqual(["src/data.json:2:1005", "src/input.ts:1:2322"]);
  expect(
    compareDiagnosticSets(
      { status: 1, diagnostics },
      { status: 1, diagnostics },
    ).passed,
  ).toBe(true);
  for (const missing of diagnostics)
    expect(
      compareDiagnosticSets(
        { status: 1, diagnostics },
        {
          status: 1,
          diagnostics: diagnostics.filter((entry) => entry !== missing),
        },
      ).passed,
    ).toBe(false);
});

test("fixture configuration errors fail even when both compiler diagnostics and exits match", () => {
  for (const output of [
    "error TS18002: The files list is empty.",
    "tsconfig.json(2,3): error TS5069: declarationDir requires declaration.",
    "error TS6310: Referenced project may not disable emit.",
  ]) {
    const result = fixtureParity({
      expected: [],
      match: "all",
      baseline: { status: 1, output },
      candidate: { status: 1, output },
    });
    expect(result.active).toBe(false);
    expect(result.configurationDiagnostics).toHaveLength(2);
    expect(result.passed).toBe(false);
  }
});

test("inactive fixture matching identities and exit statuses passes", () => {
  const check = {
    status: 1,
    output: "input.ts(1,1): error TS6133: Unused under this configuration.",
  };
  const result = fixtureParity({
    expected: [2322],
    match: "all",
    baseline: check,
    candidate: check,
  });
  expect(result.active).toBe(false);
  expect(result.configurationDiagnostics).toEqual([]);
  expect(result.passed).toBe(true);
  expect(
    fixtureParity({
      expected: [2322],
      match: "all",
      baseline: check,
      candidate: { ...check, status: 2 },
    }).passed,
  ).toBe(false);
});
