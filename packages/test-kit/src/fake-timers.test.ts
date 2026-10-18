import { describe, expect, test } from "bun:test";

import { FakeTimerLimitError, createFakeTimers } from "./fake-timers.ts";

const installRepeatingTimer = (
  timers: ReturnType<typeof createFakeTimers>,
  hangGuard: number,
): void => {
  let calls = 0;
  const callback = (): void => {
    calls += 1;
    if (calls > hangGuard) throw new Error("hang guard reached");
    timers.setTimeout(callback, 0);
  };
  timers.setTimeout(callback, 0);
};

describe("fake timers", () => {
  test("runAll bounds callbacks scheduled while draining", () => {
    const timers = createFakeTimers({ limit: 5 });
    installRepeatingTimer(timers, 6);
    expect(() => timers.runAll()).toThrow(new FakeTimerLimitError(6));
  }, 1_000);

  test("advance bounds callbacks scheduled while draining", () => {
    const timers = createFakeTimers({ limit: 5 });
    installRepeatingTimer(timers, 6);
    expect(() => timers.advance(1)).toThrow(new FakeTimerLimitError(6));
  }, 1_000);

  test("runs ordinary callback chains in due-time and insertion order", () => {
    const timers = createFakeTimers({ limit: 5 });
    const calls: string[] = [];
    timers.setTimeout(() => {
      calls.push("first");
      timers.setTimeout(() => calls.push("third"), 1);
    }, 1);
    timers.setTimeout(() => calls.push("second"), 1);

    timers.runAll();

    expect(calls).toEqual(["first", "second", "third"]);
    expect(timers.now()).toBe(2);
  });
});
