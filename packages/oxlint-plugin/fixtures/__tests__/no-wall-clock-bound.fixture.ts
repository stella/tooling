import { expect as assert } from "bun:test";
import { setTimeout as timerDelay } from "node:timers/promises";

import { delay, sleep } from "@stll/test-kit";

declare const closed: { promise: Promise<void> };
declare const reservation: Promise<void>;
declare const sleeping: { promise: Promise<void> };
declare const statementTimeoutMs: number;
declare const idleTimeoutS: number;
declare const lockTimeoutMs: number;
declare const extract: (text: string) => void;
declare const text: string;
declare const run: () => void;

const directMeasurement = () => {
  // oxlint-disable-next-line no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
  const started = performance.now();
  extract(text);
  // oxlint-disable-next-line no-wall-clock-bound/no-wall-clock-bound, no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
  expect(performance.now() - started).toBeLessThan(2000);
  // oxlint-disable-next-line no-wall-clock-bound/no-wall-clock-bound, no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
  expect(performance.now() - started).not.toBeGreaterThan(2000);
  // oxlint-disable-next-line no-wall-clock-bound/no-wall-clock-bound, no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
  assert(performance.now() - started).toBeCloseTo(10);
};

const boundMeasurement = () => {
  // oxlint-disable-next-line no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
  const t0 = Date.now();
  run();
  // oxlint-disable-next-line no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
  const elapsed = Date.now() - t0;
  // oxlint-disable-next-line no-wall-clock-bound/no-wall-clock-bound -- fixture
  expect(elapsed).toBeLessThan(20_000);
  // oxlint-disable-next-line no-wall-clock-bound/no-wall-clock-bound -- fixture
  expect(elapsed).not.toBeGreaterThanOrEqual(1000);
};

const twoTimestampMeasurement = () => {
  // oxlint-disable-next-line no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
  const start = performance.now();
  run();
  // oxlint-disable-next-line no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
  const end = performance.now();
  // oxlint-disable-next-line no-wall-clock-bound/no-wall-clock-bound -- fixture
  expect(end - start).toBeLessThan(20_000);

  // oxlint-disable-next-line no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
  const dateStart = Date.now();
  run();
  // oxlint-disable-next-line no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
  const dateEnd = Date.now();
  // oxlint-disable-next-line no-wall-clock-bound/no-wall-clock-bound -- fixture
  expect(dateEnd - dateStart).toBeLessThan(20_000);
};

const otherClocks = () => {
  const nanoseconds = Bun.nanoseconds() - 0;
  // oxlint-disable-next-line no-wall-clock-bound/no-wall-clock-bound -- fixture
  expect(nanoseconds).toBeGreaterThan(1);
  // oxlint-disable-next-line no-wall-clock-bound/no-wall-clock-bound -- fixture
  expect(process.hrtime.bigint() - 0n).toBeWithin(0n, 10n);
};

// expect-clean: no-wall-clock-bound/no-wall-clock-bound
expect(statementTimeoutMs).toBeLessThanOrEqual((idleTimeoutS * 1000) / 2);
// expect-clean: no-wall-clock-bound/no-wall-clock-bound
expect(lockTimeoutMs).toBeLessThanOrEqual(statementTimeoutMs);

const races = async () => {
  // oxlint-disable-next-line no-wall-clock-bound/no-wall-clock-bound, no-real-timer-waits-in-tests/no-real-timer-waits-in-tests -- fixture
  await Promise.race([closed.promise, Bun.sleep(200)]);
  // oxlint-disable-next-line no-wall-clock-bound/no-wall-clock-bound -- fixture
  await Promise.race([
    closed.promise,
    // oxlint-disable-next-line no-real-timer-waits-in-tests/no-real-timer-waits-in-tests -- fixture
    new Promise((resolve) => setTimeout(resolve, 200)),
  ]);
  // oxlint-disable-next-line no-wall-clock-bound/no-wall-clock-bound, no-real-timer-waits-in-tests/no-real-timer-waits-in-tests -- fixture
  await Promise.race([closed.promise, timerDelay(200)]);
  // oxlint-disable-next-line no-wall-clock-bound/no-wall-clock-bound -- fixture
  await Promise.race([closed.promise, sleep(200)]);
  // oxlint-disable-next-line no-wall-clock-bound/no-wall-clock-bound -- fixture
  await Promise.race([closed.promise, delay(200)]);
  // expect-clean: no-wall-clock-bound/no-wall-clock-bound
  await Promise.race([sleeping.promise, reservation]);
};

void directMeasurement;
void boundMeasurement;
void twoTimestampMeasurement;
void otherClocks;
void races;
