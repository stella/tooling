import { expect, test } from "bun:test";

import {
  diagnosticCodes,
  diagnosticParity,
  fixtures,
} from "./check-typecheck-parity";

test("diagnostic parsing retains codes independent of ordering, location and duplicate messages", () => {
  expect(
    diagnosticCodes(
      "input.ts(1,1): error TS2322: wrong\ninput.js:2:3: error TS7006: wrong\nerror TS2322: repeated",
    ),
  ).toEqual([2322, 7006]);
});

for (const fixture of fixtures) {
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
