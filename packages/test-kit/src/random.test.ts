import { describe, expect, test } from "bun:test";

import { createSeededRandom, testSeed } from "./random.ts";

describe("seeded randomness", () => {
  test("the same seed always produces the same sequence", () => {
    const sequence = (seed: string) => {
      const random = createSeededRandom(seed);
      return [
        random.next(),
        random.int(-2, 2),
        random.pick(["a", "b", "c"]),
        random.shuffle([1, 2, 3, 4]),
      ];
    };
    expect(sequence("repeatable")).toEqual(sequence("repeatable"));
    expect(sequence("repeatable")).not.toEqual(sequence("different"));
  });

  test("validates empty collections and integer ranges", () => {
    const random = createSeededRandom(1);
    expect(() => random.pick([])).toThrow("at least one");
    expect(() => random.int(2, 1)).toThrow("max >= min");
  });

  test("honours a reproducible seed override", () => {
    const previous = process.env["STLL_TEST_SEED"];
    process.env["STLL_TEST_SEED"] = "reported-seed";
    try {
      expect(testSeed()).toBe(testSeed());
    } finally {
      if (previous === undefined) delete process.env["STLL_TEST_SEED"];
      else process.env["STLL_TEST_SEED"] = previous;
    }
  });
});
