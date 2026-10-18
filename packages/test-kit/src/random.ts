export type Seed = number | string;

export type SeededRandom = {
  next: () => number;
  int: (min: number, max: number) => number;
  pick: <T>(items: readonly T[]) => T;
  shuffle: <T>(items: readonly T[]) => T[];
};

const hashSeed = (seed: Seed): number => {
  const text = String(seed);
  let hash = 2_166_136_261;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

/** A small, reproducible PRNG. It is not suitable for cryptography. */
export const createSeededRandom = (seed: Seed): SeededRandom => {
  let state = hashSeed(seed);
  const next = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
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
      return min + Math.floor(next() * (max - min + 1));
    },
    pick: (items) => {
      if (items.length === 0) {
        throw new RangeError("pick needs at least one item");
      }
      return items[Math.floor(next() * items.length)]!;
    },
    shuffle: (items) => {
      const result = Array.from(items);
      for (let index = result.length - 1; index > 0; index -= 1) {
        const other = Math.floor(next() * (index + 1));
        [result[index], result[other]] = [result[other]!, result[index]!];
      }
      return result;
    },
  };
};

/** Returns the override seed, or a stable hash of the running test's full name. */
export const testSeed = (): number => {
  const override = process.env["STLL_TEST_SEED"];
  const caller = new Error().stack?.split("\n").at(2)?.trim();
  const source = override ?? caller;
  if (source === undefined || source.length === 0) {
    throw new Error("testSeed() could not identify the running test");
  }
  const seed = hashSeed(source);
  // Bun includes test console output with failures, making the exact seed reusable.
  console.info(`STLL_TEST_SEED=${String(seed)}`);
  return seed;
};
