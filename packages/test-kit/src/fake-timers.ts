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

const MAX_TIMER_CALLBACKS = 10_000;
let fakeTimersScopeActive = false;

const normalizeDelay = (delay: number) =>
  Number.isFinite(delay) && delay > 0 ? delay : 0;

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
    const normalizedDelay = normalizeDelay(delay);
    const timer = {
      args,
      callback,
      dueAt: clock.monotonic() + normalizedDelay,
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
      )
      .at(0);
  const drain = async (target: number) => {
    let callbackCount = 0;
    for (;;) {
      const timer = nextDue(target);
      if (timer === undefined) break;
      if (++callbackCount > MAX_TIMER_CALLBACKS) {
        throw new Error(
          `timer run exceeded ${String(MAX_TIMER_CALLBACKS)} callbacks; clear self-rescheduling timers first`,
        );
      }
      const timeUntilDue = timer.dueAt - clock.monotonic();
      if (timeUntilDue > 0) await clock.advance(timeUntilDue);
      if (!timers.delete(timer.id)) continue;
      if (timer.interval !== undefined) {
        timer.dueAt += timer.interval;
        timer.sequence = sequence++;
        timers.set(timer.id, timer);
      }
      timer.callback(...timer.args);
      await Promise.resolve();
    }
  };
  const advance = async (milliseconds: number) => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
      throw new RangeError("advance must be finite and non-negative");
    const target = clock.monotonic() + milliseconds;
    await drain(target);
    const remaining = target - clock.monotonic();
    if (remaining > 0) await clock.advance(remaining);
  };
  return {
    clock,
    setTimeout: (callback, delay, ...args) =>
      schedule(callback, delay, undefined, args),
    setInterval: (callback, delay = 0, ...args) => {
      const normalizedDelay = normalizeDelay(delay);
      return schedule(
        callback,
        normalizedDelay,
        Math.max(normalizedDelay, 1),
        args,
      );
    },
    clearTimeout: (timerId) => {
      timers.delete(timerId);
    },
    clearInterval: (timerId) => {
      timers.delete(timerId);
    },
    advance,
    runAll: async () => {
      await drain(Number.POSITIVE_INFINITY);
    },
    pendingTimers: () => timers.size,
  };
};

export const withFakeTimers = async <T>(
  fn: (timers: FakeTimers) => T | Promise<T>,
): Promise<T> => {
  if (fakeTimersScopeActive) {
    throw new Error("withFakeTimers scopes must not overlap");
  }
  fakeTimersScopeActive = true;
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
    fakeTimersScopeActive = false;
  }
};
