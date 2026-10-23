export type Seed = number | string;

export type SeededRandom = {
  next: () => number;
  int: (min: number, max: number) => number;
  pick: <T>(items: readonly T[]) => T;
  shuffle: <T>(items: readonly T[]) => T[];
};

const UINT32_RANGE = 4_294_967_296;
const UINT53_RANGE = 9_007_199_254_740_992;

const hashSeed = (seed: Seed): number => {
  const text = String(seed);
  let hash = 2_166_136_261;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

const readAt = <T>(items: readonly T[], index: number): T => {
  for (const [itemIndex, item] of items.entries()) {
    if (itemIndex === index) return item;
  }
  throw new RangeError("index is outside the collection");
};

/** A small, reproducible PRNG. It is not suitable for cryptography. */
export const createSeededRandom = (seed: Seed): SeededRandom => {
  let state = hashSeed(seed);
  const nextUint32 = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
  const next = () => nextUint32() / UINT32_RANGE;
  return {
    next,
    int: (min, max) => {
      if (
        !Number.isSafeInteger(min) ||
        !Number.isSafeInteger(max) ||
        max < min
      ) {
        throw new RangeError(
          "int bounds must be safe integers with max >= min",
        );
      }
      const range = max - min + 1;
      if (!Number.isSafeInteger(range)) {
        throw new RangeError(
          "int range must not exceed Number.MAX_SAFE_INTEGER",
        );
      }
      if (range <= UINT32_RANGE) return min + Math.floor(next() * range);

      for (;;) {
        const value = (nextUint32() & 0x1f_ffff) * UINT32_RANGE + nextUint32();
        const limit = Math.floor(UINT53_RANGE / range) * range;
        if (value < limit) return min + (value % range);
      }
    },
    pick: (items) => {
      if (items.length === 0)
        throw new RangeError("pick needs at least one item");
      return readAt(items, Math.floor(next() * items.length));
    },
    shuffle: (items) => {
      const result = Array.from(items);
      for (let index = result.length - 1; index > 0; index -= 1) {
        const other = Math.floor(next() * (index + 1));
        const currentValue = readAt(result, index);
        const otherValue = readAt(result, other);
        result[index] = otherValue;
        result[other] = currentValue;
      }
      return result;
    },
  };
};

const parseOverrideSeed = (override: string): number => {
  if (!/^\d+$/.test(override)) {
    throw new RangeError("STLL_TEST_SEED must be an unsigned 32-bit integer");
  }
  const seed = Number(override);
  if (!Number.isInteger(seed) || seed < 0 || seed >= UINT32_RANGE) {
    throw new RangeError("STLL_TEST_SEED must be an unsigned 32-bit integer");
  }
  return seed;
};

/** Returns the override seed, or a stable hash of the running test's full name. */
export const testSeed = (): number => {
  const override = process.env["STLL_TEST_SEED"];
  const caller = new Error().stack?.split("\n").at(2)?.trim();
  if (override === undefined && (caller === undefined || caller.length === 0)) {
    throw new Error("testSeed() could not identify the running test");
  }
  const seed =
    override === undefined
      ? hashSeed(caller ?? "")
      : parseOverrideSeed(override);
  // Bun includes test console output with failures, making the exact seed reusable.
  console.info(`STLL_TEST_SEED=${String(seed)}`);
  return seed;
};
