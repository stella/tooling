import { describe, expect, test } from "bun:test";

import {
  expectLinearScaling,
  linearScalingTestInternals,
} from "./linear-scaling.ts";

let sink = 0;

describe("expectLinearScaling", () => {
  test("accepts linear work", async () => {
    await expectLinearScaling({
      sizes: [50_000, 200_000, 800_000],
      repeats: 5,
      run: (size) => {
        let total = 0;
        for (let index = 0; index < size; index += 1) total += index;
        sink = total;
      },
    });
  });

  test("rejects quadratic work before running the next size", async () => {
    const calls = new Map<number, number>();
    const assertion = expectLinearScaling({
      sizes: [250, 1_000, 4_000],
      repeats: 5,
      run: (size) => {
        calls.set(size, (calls.get(size) ?? 0) + 1);
        let total = 0;
        for (let outer = 0; outer < size; outer += 1) {
          for (let inner = 0; inner < size; inner += 1) total += outer + inner;
        }
        sink = total;
      },
    });
    expect(assertion).rejects.toThrow(/size 250 .*size 1000.*median/u);
    await assertion.catch(() => {});
    expect(calls.has(4_000)).toBeFalse();
  });

  test("accepts constant timing noise", async () => {
    await expectLinearScaling({
      sizes: [1, 4, 16],
      repeats: 5,
      run: () => {
        let total = 0;
        for (let index = 0; index < 200_000; index += 1) total += index;
        sink = total;
      },
    });
  });

  test("validates measurement options", async () => {
    expect(
      expectLinearScaling({ run: () => {}, sizes: [2, 1] }),
    ).rejects.toThrow("strictly increasing");
    expect(
      expectLinearScaling({ run: () => {}, sizes: [1, 2], repeats: 0 }),
    ).rejects.toThrow("positive integer");
  });

  test("calibrates sub-microsecond linear work without flaking", async () => {
    const runLinearWork = (size: number) => {
      for (let index = 0; index < size; index += 1) sink += index;
    };
    for (let trial = 0; trial < 20; trial += 1) {
      await expectLinearScaling({
        sizes: [1, 4, 16],
        run: runLinearWork,
      });
    }
  });

  test("rejects a synchronous run when the clock does not advance", async () => {
    const assertion = linearScalingTestInternals.expectLinearScalingWithClock(
      { run: () => {}, sizes: [2, 4] },
      { minimumSampleDurationMs: 5, now: () => 10 },
    );
    expect(assertion).rejects.toThrow(TypeError);
    expect(assertion).rejects.toThrow(/size 2.*clock did not advance/u);
    await assertion.catch(() => {});
  });

  test("rejects an asynchronous run when the clock does not advance", async () => {
    const assertion = linearScalingTestInternals.expectLinearScalingWithClock(
      { run: async () => {}, sizes: [2, 4] },
      { minimumSampleDurationMs: 5, now: () => 10 },
    );
    expect(assertion).rejects.toThrow(TypeError);
    expect(assertion).rejects.toThrow(/size 2.*clock did not advance/u);
    await assertion.catch(() => {});
  });

  test("rejects zero-duration samples and names the size", async () => {
    const assertion = linearScalingTestInternals.expectLinearScalingWithClock(
      { run: () => {}, sizes: [2, 4] },
      { minimumSampleDurationMs: 0, now: () => 10 },
    );
    expect(assertion).rejects.toThrow(TypeError);
    expect(assertion).rejects.toThrow("size 2");
    await assertion.catch(() => {});
  });

  test("calibration exposes quadratic growth below clock resolution", async () => {
    let work = 0;
    const calls = new Map<number, number>();
    const assertion = linearScalingTestInternals.expectLinearScalingWithClock(
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
    );
    expect(assertion).rejects.toThrow(/size 1 .*size 2/u);
    await assertion.catch(() => {});
    expect(calls.has(4)).toBeFalse();
  });

  test("batches synchronous calls so constant measurement overhead cannot hide quadratic growth", async () => {
    let work = 0;
    let clockReads = 0;
    const calls = new Map<number, number>();
    const assertion = linearScalingTestInternals.expectLinearScalingWithClock(
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
    );
    expect(assertion).rejects.toThrow(/size 1 .*size 2/u);
    await assertion.catch(() => {});
    expect(calls.has(4)).toBeFalse();
  });
});

void sink;
