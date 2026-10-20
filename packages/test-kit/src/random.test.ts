import { describe, expect, test } from "bun:test";

import { createSeededRandom, testSeed } from "./random.ts";

const withSeedOverride = (seed: string, fn: () => void) => {
  const previous = process.env["STLL_TEST_SEED"];
  process.env["STLL_TEST_SEED"] = seed;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env["STLL_TEST_SEED"];
    else process.env["STLL_TEST_SEED"] = previous;
  }
};

describe("seeded randomness", () => {
  test("the same seed always produces the same sequence", () => {
    const sequence = (seed: string | number) => {
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

  test("replays the sequence from the printed seed assignment", () => {
    const seed = testSeed();
    const expected = createSeededRandom(seed);
    const expectedSequence = [
      expected.next(),
      expected.next(),
      expected.next(),
    ];

    withSeedOverride(String(seed), () => {
      const replay = createSeededRandom(testSeed());
      expect([replay.next(), replay.next(), replay.next()]).toEqual(
        expectedSequence,
      );
    });
  });

  test("validates seed overrides", () => {
    for (const invalid of ["-1", "1.5", "4294967296", "seed"]) {
      withSeedOverride(invalid, () => {
        expect(() => testSeed()).toThrow("unsigned 32-bit integer");
      });
    }
  });

  test("validates empty collections and integer ranges", () => {
    const random = createSeededRandom(1);
    expect(() => random.pick([])).toThrow("at least one");
    expect(() => random.int(2, 1)).toThrow("max >= min");
  });

  test("draws across integer ranges wider than 32 bits", () => {
    const random = createSeededRandom("wide range");
    const maximum = 2 ** 40;
    const values = Array.from({ length: 100 }, () => random.int(0, maximum));
    expect(
      values.every(
        (value) => Number.isInteger(value) && value >= 0 && value <= maximum,
      ),
    ).toBeTrue();
    expect(values.some((value) => value > 2 ** 32)).toBeTrue();
  });

  test("accepts the widest safe range and rejects a wider one", () => {
    const random = createSeededRandom("range edges");
    expect(random.int(0, Number.MAX_SAFE_INTEGER - 1)).toBeWithin(
      0,
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => random.int(0, Number.MAX_SAFE_INTEGER)).toThrow(
      "must not exceed Number.MAX_SAFE_INTEGER",
    );
  });
});
