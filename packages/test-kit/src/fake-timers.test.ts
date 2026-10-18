import { expect, test } from "bun:test";

import { createTestClock } from "./clock.ts";
import { createFakeTimers, withFakeTimers } from "./fake-timers.ts";

const scheduleBoundedLoop = (
  timers: ReturnType<typeof createFakeTimers>,
  limit: number,
) => {
  let count = 0;
  const reschedule = () => {
    count += 1;
    if (count < limit) timers.setTimeout(reschedule, 0);
  };
  timers.setTimeout(reschedule, 0);
};

test("advancing fires exactly the due timers in deadline and insertion order", async () => {
  const timers = createFakeTimers();
  const fired: string[] = [];
  timers.setTimeout(() => {
    fired.push("late");
  }, 20);
  timers.setTimeout(() => {
    fired.push("first");
  }, 10);
  timers.setTimeout(() => {
    fired.push("second");
  }, 10);
  await timers.advance(10);
  expect(fired).toEqual(["first", "second"]);
  await timers.advance(10);
  expect(fired).toEqual(["first", "second", "late"]);
});

test("clamps negative and non-finite timer delays to zero", async () => {
  const timers = createFakeTimers();
  const fired: string[] = [];
  for (const delay of [
    -1,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ]) {
    timers.setTimeout(() => {
      fired.push(String(delay));
    }, delay);
  }
  await timers.advance(0);
  expect(fired).toEqual(["-1", "NaN", "-Infinity", "Infinity"]);
});

test("runs overdue timers in due order after a shared clock advances", async () => {
  const clock = createTestClock();
  const timers = createFakeTimers({ clock });
  const fired: string[] = [];
  timers.setTimeout(() => {
    fired.push("second");
  }, 20);
  timers.setTimeout(() => {
    fired.push("first");
  }, 10);
  await clock.advance(30);
  await timers.advance(0);
  expect(fired).toEqual(["first", "second"]);
});

test("runAll limits callbacks inside one drain", async () => {
  const runAllTimers = createFakeTimers();
  scheduleBoundedLoop(runAllTimers, 10_001);
  expect(runAllTimers.runAll()).rejects.toThrow("exceeded 10000 callbacks");
});

test("advance limits callbacks inside one drain", async () => {
  const advanceTimers = createFakeTimers();
  scheduleBoundedLoop(advanceTimers, 10_001);
  expect(advanceTimers.advance(1)).rejects.toThrow("exceeded 10000 callbacks");
});

test("ordinary callback chains run in order", async () => {
  const timers = createFakeTimers();
  const fired: number[] = [];
  const chain = (value: number) => {
    fired.push(value);
    if (value < 3)
      timers.setTimeout(() => {
        chain(value + 1);
      }, 0);
  };
  timers.setTimeout(() => {
    chain(1);
  }, 0);
  await timers.runAll();
  expect(fired).toEqual([1, 2, 3]);
});

test("withFakeTimers restores globals after a thrown test body", async () => {
  const real = globalThis.setTimeout;
  const operation = withFakeTimers(() => {
    expect(globalThis.setTimeout).not.toBe(real);
    throw new Error("boom");
  });
  expect(operation).rejects.toThrow("boom");
  await operation.catch(() => undefined);
  expect(globalThis.setTimeout).toBe(real);
});

test("overlapping withFakeTimers scopes fail without disturbing globals", async () => {
  const real = globalThis.setTimeout;
  await withFakeTimers(async () => {
    const outerFake = globalThis.setTimeout;
    const overlap = withFakeTimers(() => undefined);
    expect(overlap).rejects.toThrow("must not overlap");
    await overlap.catch(() => undefined);
    expect(globalThis.setTimeout).toBe(outerFake);
  });
  expect(globalThis.setTimeout).toBe(real);
});

test("intervals repeat until cleared", async () => {
  const timers = createFakeTimers();
  let ticks = 0;
  const id = timers.setInterval(() => {
    ticks += 1;
    if (ticks === 3) timers.clearInterval(id);
  }, 5);
  await timers.advance(30);
  expect(ticks).toBe(3);
});
