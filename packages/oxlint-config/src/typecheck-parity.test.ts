/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  compareDiagnosticSets,
  diagnosticCodes,
  diagnosticSet,
  fixtureParity,
  fixtureRunPassed,
  diagnosticParity,
  fixtures,
  resolveCompiler,
} from "./typecheck-parity";

const repo = resolve("/consumer-repo");

const compilerPolicy = {
  typescriptInstallLayouts: [
    { type: "direct", compilerPackage: "typescript" },
    { type: "split-compatibility", compilerPackage: "@typescript/native" },
  ],
};

const compilerFixture = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "parity-compiler-test-"));
  try {
    for (const name of ["typescript", "@typescript/native"]) {
      const directory = join(root, "node_modules", name);
      await mkdir(join(directory, "bin"), { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name, bin: { tsc: "bin/tsc.js" } }),
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
    await expect(resolveCompiler(root, compilerPolicy)).rejects.toThrow(
      "Repository must declare a compiler",
    );
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
      JSON.stringify({ name: "typescript", bin: {} }),
    );
    await expect(resolveCompiler(root, compilerPolicy)).rejects.toThrow(
      "must expose a tsc binary",
    );
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
  ).toEqual(["<config>:0:18003", "<config>:0:5083"]);
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
