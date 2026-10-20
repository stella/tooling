import { describe, expect, test } from "bun:test";

import { expectLinearScaling } from "./linear-scaling.ts";

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

  test("rejects quadratic work and names the measurements", async () => {
    const assertion = expectLinearScaling({
      sizes: [250, 1_000, 4_000],
      repeats: 5,
      run: (size) => {
        let total = 0;
        for (let outer = 0; outer < size; outer += 1) {
          for (let inner = 0; inner < size; inner += 1) total += outer + inner;
        }
        sink = total;
      },
    });
    expect(assertion).rejects.toThrow(
      /size (?:250 .*size 1000|1000 .*size 4000).*median/u,
    );
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
    expect(expectLinearScaling({ run: () => {}, repeats: 0 })).rejects.toThrow(
      "positive integer",
    );
  });
});

void sink;
