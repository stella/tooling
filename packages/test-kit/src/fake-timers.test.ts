import { expect, test } from "bun:test";

import { createFakeTimers, withFakeTimers } from "./fake-timers.ts";

test("advancing fires exactly the due timers in deadline and insertion order", async () => {
  const timers = createFakeTimers();
  const fired: string[] = [];
  timers.setTimeout(() => fired.push("late"), 20);
  timers.setTimeout(() => fired.push("first"), 10);
  timers.setTimeout(() => fired.push("second"), 10);
  await timers.advance(10);
  expect(fired).toEqual(["first", "second"]);
  await timers.advance(10);
  expect(fired).toEqual(["first", "second", "late"]);
});

test("withFakeTimers restores globals after a thrown test body", async () => {
  const real = globalThis.setTimeout;
  await expect(
    withFakeTimers(() => {
      expect(globalThis.setTimeout).not.toBe(real);
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
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
