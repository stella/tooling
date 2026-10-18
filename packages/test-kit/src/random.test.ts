import { afterEach, describe, expect, test } from "bun:test";

import { createTestRandom, testSeed } from "./random.ts";

const originalSeed = process.env["STLL_TEST_SEED"];

afterEach(() => {
  if (originalSeed === undefined) delete process.env["STLL_TEST_SEED"];
  else process.env["STLL_TEST_SEED"] = originalSeed;
});

describe("test random", () => {
  test("replays a sequence from its printed seed assignment", () => {
    delete process.env["STLL_TEST_SEED"];
    const original = createTestRandom("replay example");
    const assignment = `STLL_TEST_SEED=${original.seed}`;
    const expected = Array.from({ length: 5 }, () => original.next());

    process.env["STLL_TEST_SEED"] = assignment.slice(
      assignment.indexOf("=") + 1,
    );
    const replay = createTestRandom("a different source");

    expect(Array.from({ length: 5 }, () => replay.next())).toEqual(expected);
  });

  test.each(["-1", "1.5", "4294967296", "not-a-number"])(
    "rejects invalid seed override %s",
    (value) => {
      process.env["STLL_TEST_SEED"] = value;
      expect(() => testSeed("example")).toThrow("unsigned 32-bit integer");
    },
  );
});
