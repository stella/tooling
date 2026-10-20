import { describe, expect, test } from "bun:test";

import {
  expectLinearScaling,
  linearScalingTestInternals,
} from "./linear-scaling.ts";
import { rejectionOf } from "./rejection-support.ts";

const createWorkClock = (
  cost: (size: number) => number,
  minimumSampleDurationMs = 5,
) => {
  let elapsed = 0;
  return {
    clock: { minimumSampleDurationMs, now: () => elapsed },
    run: (size: number) => {
      elapsed += cost(size);
    },
  };
};

const createSeededNoise = (initialSeed: number) => {
  let seed = initialSeed;
  return () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 2 ** 32;
  };
};

describe("expectLinearScaling", () => {
  test("accepts linear work", async () => {
    const { clock, run } = createWorkClock((size) => size / 1_000);
    await linearScalingTestInternals.expectLinearScalingWithClock(
      { sizes: [50, 200, 800], repeats: 5, run },
      clock,
    );
  });

  test("rejects quadratic work before running the next size", async () => {
    const calls = new Map<number, number>();
    const { clock, run } = createWorkClock((size) => size * size);
    const error = await rejectionOf(
      linearScalingTestInternals.expectLinearScalingWithClock(
        {
          sizes: [1, 4, 16],
          repeats: 5,
          run: (size) => {
            calls.set(size, (calls.get(size) ?? 0) + 1);
            run(size);
          },
        },
        clock,
      ),
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/size 1 .*size 4.*median/u);
    expect(calls.has(16)).toBeFalse();
  });

  test("accepts constant timing noise", async () => {
    const noise = createSeededNoise(0x5eed);
    const { clock, run } = createWorkClock(() => 10 + noise());
    await linearScalingTestInternals.expectLinearScalingWithClock(
      { sizes: [1, 4, 16], repeats: 5, run },
      clock,
    );
  });

  test("validates measurement options", async () => {
    const sizesError = await rejectionOf(
      expectLinearScaling({ run: () => {}, sizes: [2, 1] }),
    );
    expect(sizesError).toBeInstanceOf(TypeError);
    expect(String(sizesError)).toContain("strictly increasing");

    const repeatsError = await rejectionOf(
      expectLinearScaling({ run: () => {}, sizes: [1, 4], repeats: 0 }),
    );
    expect(repeatsError).toBeInstanceOf(TypeError);
    expect(String(repeatsError)).toContain("positive integer");
  });

  test("rejects size ratios that cannot distinguish quadratic growth", async () => {
    let calls = 0;
    const error = await rejectionOf(
      expectLinearScaling({
        run: () => {
          calls += 1;
        },
        sizes: [10_000, 20_000, 40_000],
      }),
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain(
      "sizes 10000 and 20000 must have a ratio greater than 2.5",
    );
    expect(calls).toBe(0);
  });

  test("calibrates sub-microsecond linear work without flaking", async () => {
    for (let trial = 0; trial < 20; trial += 1) {
      const { clock, run } = createWorkClock((size) => size / 10_000);
      await linearScalingTestInternals.expectLinearScalingWithClock(
        { sizes: [1, 4, 16], run },
        clock,
      );
    }
  });

  test("rejects a synchronous run when the clock does not advance", async () => {
    const error = await rejectionOf(
      linearScalingTestInternals.expectLinearScalingWithClock(
        { run: () => {}, sizes: [2, 8] },
        { minimumSampleDurationMs: 5, now: () => 10 },
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toMatch(/size 2.*clock did not advance/u);
  });

  test("rejects a pending callback switch without awaiting the callback", async () => {
    let calls = 0;
    let rejection: unknown;
    const scaling = linearScalingTestInternals.expectLinearScalingWithClock(
      {
        run: () => {
          calls += 1;
          if (calls === 1) return undefined;
          return new Promise(() => {});
        },
        sizes: [2, 8],
      },
      { minimumSampleDurationMs: 5, now: () => calls * 5 },
    );
    void rejectionOf(scaling).then((error) => {
      rejection = error;
      return error;
    });
    await Bun.sleep(0);

    expect(rejection).toBeInstanceOf(TypeError);
    expect(String(rejection)).toContain(
      "switched from synchronous to asynchronous at size 2",
    );
  });

  test("rejects an asynchronous run when the clock does not advance", async () => {
    let calls = 0;
    const error = await rejectionOf(
      linearScalingTestInternals.expectLinearScalingWithClock(
        {
          run: async () => {
            calls += 1;
          },
          sizes: [2, 8],
        },
        { minimumSampleDurationMs: 5, now: () => 10 },
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toMatch(/size 2.*clock did not advance/u);
    expect(calls).toBeLessThanOrEqual(
      linearScalingTestInternals.maximumAsynchronousCalibrationCalls + 1,
    );
  });

  test("rejects a callback that switches from synchronous to asynchronous without an unhandled rejection", async () => {
    let calls = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const error = await rejectionOf(
      linearScalingTestInternals.expectLinearScalingWithClock(
        {
          run: () => {
            calls += 1;
            if (calls === 1) return undefined;
            return Promise.reject(new Error("measurement rejected"));
          },
          sizes: [2, 8],
        },
        { minimumSampleDurationMs: 5, now: () => calls * 5 },
      ),
    );
    await Bun.sleep(0);
    process.off("unhandledRejection", onUnhandled);

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain(
      "switched from synchronous to asynchronous at size 2",
    );
    expect(unhandled).toEqual([]);
  });

  test("rejects a callback that switches from asynchronous to synchronous", async () => {
    let calls = 0;
    const error = await rejectionOf(
      linearScalingTestInternals.expectLinearScalingWithClock(
        {
          run: () => {
            calls += 1;
            return calls === 1 ? Promise.resolve() : undefined;
          },
          sizes: [2, 8],
        },
        { minimumSampleDurationMs: 5, now: () => calls * 5 },
      ),
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain(
      "switched from asynchronous to synchronous at size 2",
    );
  });

  test("rejects zero-duration samples and names the size", async () => {
    const error = await rejectionOf(
      linearScalingTestInternals.expectLinearScalingWithClock(
        { run: () => {}, sizes: [2, 8] },
        { minimumSampleDurationMs: 0, now: () => 10 },
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain("size 2");
  });

  test("calibration exposes quadratic growth below clock resolution", async () => {
    let work = 0;
    const calls = new Map<number, number>();
    const error = await rejectionOf(
      linearScalingTestInternals.expectLinearScalingWithClock(
        {
          sizes: [1, 2, 4],
          repeats: 3,
          maxGrowthFactor: 1.5,
          run: (size) => {
            calls.set(size, (calls.get(size) ?? 0) + 1);
            work += size * size;
          },
        },
        { minimumSampleDurationMs: 5, now: () => Math.floor(work / 100) },
      ),
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/size 1 .*size 2/u);
    expect(calls.has(4)).toBeFalse();
  });

  test("batches synchronous calls so constant measurement overhead cannot hide quadratic growth", async () => {
    let work = 0;
    let clockReads = 0;
    const calls = new Map<number, number>();
    const error = await rejectionOf(
      linearScalingTestInternals.expectLinearScalingWithClock(
        {
          sizes: [1, 2, 4],
          repeats: 3,
          maxGrowthFactor: 1.5,
          run: (size) => {
            calls.set(size, (calls.get(size) ?? 0) + 1);
            work += size * size;
          },
        },
        {
          minimumSampleDurationMs: 1_000,
          now: () => work + clockReads++ * 100,
        },
      ),
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/size 1 .*size 2/u);
    expect(calls.has(4)).toBeFalse();
  });
});
