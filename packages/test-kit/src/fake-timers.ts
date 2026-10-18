export const DEFAULT_FAKE_TIMER_LIMIT = 10_000;

type TimerCallback = () => void;

type ScheduledTimer = {
  callback: TimerCallback;
  dueAt: number;
  id: number;
};

export class FakeTimerLimitError extends Error {
  readonly count: number;

  constructor(count: number) {
    super(`Fake timer callback limit exceeded after ${count} callbacks`);
    this.name = "FakeTimerLimitError";
    this.count = count;
  }
}

export type FakeTimersOptions = {
  limit?: number;
  now?: number;
};

export type FakeTimers = {
  advance: (milliseconds: number) => void;
  clearTimeout: (id: number) => void;
  now: () => number;
  runAll: () => void;
  setTimeout: (callback: TimerCallback, delay?: number) => number;
};

export const createFakeTimers = ({
  limit = DEFAULT_FAKE_TIMER_LIMIT,
  now: initialNow = 0,
}: FakeTimersOptions = {}): FakeTimers => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("fake timer limit must be a positive safe integer");
  }
  if (!Number.isFinite(initialNow)) {
    throw new RangeError("fake timer current time must be finite");
  }

  let currentTime = initialNow;
  let nextId = 1;
  const timers = new Map<number, ScheduledTimer>();

  const setTimeout = (callback: TimerCallback, delay = 0): number => {
    if (!Number.isFinite(delay)) {
      throw new RangeError("fake timer delay must be finite");
    }

    const id = nextId;
    nextId += 1;
    timers.set(id, {
      callback,
      dueAt: currentTime + Math.max(0, delay),
      id,
    });
    return id;
  };

  const clearTimeout = (id: number): void => {
    timers.delete(id);
  };

  const nextTimer = (deadline: number): ScheduledTimer | undefined => {
    let selected: ScheduledTimer | undefined;
    for (const timer of timers.values()) {
      if (timer.dueAt > deadline) continue;
      if (
        selected === undefined ||
        timer.dueAt < selected.dueAt ||
        (timer.dueAt === selected.dueAt && timer.id < selected.id)
      ) {
        selected = timer;
      }
    }
    return selected;
  };

  const drainThrough = (deadline: number, execution = { count: 0 }): void => {
    let timer = nextTimer(deadline);
    while (timer !== undefined) {
      execution.count += 1;
      if (execution.count > limit)
        throw new FakeTimerLimitError(execution.count);

      timers.delete(timer.id);
      currentTime = timer.dueAt;
      timer.callback();
      timer = nextTimer(deadline);
    }
    currentTime = deadline;
  };

  const advance = (milliseconds: number): void => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError(
        "fake timer advance must be a non-negative finite number",
      );
    }
    drainThrough(currentTime + milliseconds);
  };

  const runAll = (): void => {
    const execution = { count: 0 };
    let timer = nextTimer(Number.POSITIVE_INFINITY);
    while (timer !== undefined) {
      drainThrough(timer.dueAt, execution);
      timer = nextTimer(Number.POSITIVE_INFINITY);
    }
  };

  return {
    advance,
    clearTimeout,
    now: () => currentTime,
    runAll,
    setTimeout,
  };
};
