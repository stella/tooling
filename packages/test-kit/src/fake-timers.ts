import { createTestClock, type TestClock } from "./clock.ts";

type TimerCallback = (...args: unknown[]) => void;
type Timer = {
  args: unknown[];
  callback: TimerCallback;
  dueAt: number;
  id: number;
  interval: number | undefined;
  sequence: number;
};

export type FakeTimers = {
  clock: TestClock;
  setTimeout: (
    callback: TimerCallback,
    delay?: number,
    ...args: unknown[]
  ) => number;
  setInterval: (
    callback: TimerCallback,
    delay?: number,
    ...args: unknown[]
  ) => number;
  clearTimeout: (id: number) => void;
  clearInterval: (id: number) => void;
  advance: (milliseconds: number) => Promise<void>;
  runAll: () => Promise<void>;
  pendingTimers: () => number;
};

const MAX_RUN_ALL_TIMERS = 10_000;

export const createFakeTimers = ({
  clock = createTestClock(),
}: { clock?: TestClock } = {}): FakeTimers => {
  let id = 0;
  let sequence = 0;
  const timers = new Map<number, Timer>();
  const schedule = (
    callback: TimerCallback,
    delay = 0,
    interval?: number,
    args: unknown[] = [],
  ) => {
    if (!Number.isFinite(delay) || delay < 0)
      throw new RangeError("timer delay must be finite and non-negative");
    const timer = {
      args,
      callback,
      dueAt: clock.monotonic() + delay,
      id: ++id,
      interval,
      sequence: sequence++,
    };
    timers.set(timer.id, timer);
    return timer.id;
  };
  const nextDue = (target = Number.POSITIVE_INFINITY) =>
    [...timers.values()]
      .filter((timer) => timer.dueAt <= target)
      .sort(
        (left, right) =>
          left.dueAt - right.dueAt || left.sequence - right.sequence,
      )[0];
  const advance = async (milliseconds: number) => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
      throw new RangeError("advance must be finite and non-negative");
    const target = clock.monotonic() + milliseconds;
    for (;;) {
      const timer = nextDue(target);
      if (timer === undefined) break;
      await clock.advance(timer.dueAt - clock.monotonic());
      if (!timers.delete(timer.id)) continue;
      if (timer.interval !== undefined) {
        timer.dueAt += timer.interval;
        timer.sequence = sequence++;
        timers.set(timer.id, timer);
      }
      timer.callback(...timer.args);
      await Promise.resolve();
    }
    await clock.advance(target - clock.monotonic());
  };
  return {
    clock,
    setTimeout: (callback, delay, ...args) =>
      schedule(callback, delay, undefined, args),
    setInterval: (callback, delay = 0, ...args) =>
      schedule(callback, delay, Math.max(delay, 1), args),
    clearTimeout: (timerId) => {
      timers.delete(timerId);
    },
    clearInterval: (timerId) => {
      timers.delete(timerId);
    },
    advance,
    runAll: async () => {
      let count = 0;
      while (timers.size > 0) {
        const timer = nextDue();
        if (timer === undefined) return;
        if (++count > MAX_RUN_ALL_TIMERS)
          throw new Error(
            `runAll exceeded ${String(MAX_RUN_ALL_TIMERS)} timers; clear recurring intervals first`,
          );
        await advance(timer.dueAt - clock.monotonic());
      }
    },
    pendingTimers: () => timers.size,
  };
};

export const withFakeTimers = async <T>(
  fn: (timers: FakeTimers) => T | Promise<T>,
): Promise<T> => {
  const timers = createFakeTimers();
  const originals = { clearInterval, clearTimeout, setInterval, setTimeout };
  Reflect.set(globalThis, "setTimeout", timers.setTimeout);
  Reflect.set(globalThis, "setInterval", timers.setInterval);
  Reflect.set(globalThis, "clearTimeout", timers.clearTimeout);
  Reflect.set(globalThis, "clearInterval", timers.clearInterval);
  try {
    return await fn(timers);
  } finally {
    Reflect.set(globalThis, "setTimeout", originals.setTimeout);
    Reflect.set(globalThis, "setInterval", originals.setInterval);
    Reflect.set(globalThis, "clearTimeout", originals.clearTimeout);
    Reflect.set(globalThis, "clearInterval", originals.clearInterval);
  }
};
