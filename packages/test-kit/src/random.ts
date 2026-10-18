const UINT32_MAX = 0xffff_ffff;
const DEFAULT_SEED_SOURCE = "@stll/test-kit";

const hashSeed = (source: string): number => {
  let hash = 0x811c_9dc5;

  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }

  return hash >>> 0;
};

const parseSeedOverride = (value: string): number => {
  if (!/^\d+$/.test(value)) {
    throw new TypeError(
      `STLL_TEST_SEED must be an unsigned 32-bit integer, received ${JSON.stringify(value)}`,
    );
  }

  const seed = Number(value);
  if (!Number.isSafeInteger(seed) || seed > UINT32_MAX) {
    throw new RangeError(
      `STLL_TEST_SEED must be an unsigned 32-bit integer, received ${JSON.stringify(value)}`,
    );
  }

  return seed;
};

export const testSeed = (source = DEFAULT_SEED_SOURCE): number => {
  const override = process.env["STLL_TEST_SEED"];
  return override === undefined
    ? hashSeed(source)
    : parseSeedOverride(override);
};

export type TestRandom = {
  readonly seed: number;
  next: () => number;
  integer: (minimum: number, maximum: number) => number;
};

export const createTestRandom = (source?: string): TestRandom => {
  const seed = testSeed(source);
  let state = seed;

  const next = (): number => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };

  return {
    seed,
    next,
    integer: (minimum, maximum) => {
      if (
        !Number.isSafeInteger(minimum) ||
        !Number.isSafeInteger(maximum) ||
        maximum < minimum
      ) {
        throw new RangeError(
          "random integer bounds must be safe integers with maximum >= minimum",
        );
      }

      return minimum + Math.floor(next() * (maximum - minimum + 1));
    },
  };
};
