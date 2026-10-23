import { setTimeout as delay } from "node:timers/promises";
import * as timers from "node:timers/promises";

import { fakeTimers, wait } from "@stll/test-kit";
// oxlint-disable-next-line no-real-timer-waits-in-tests/no-real-timer-waits-in-tests -- fixture
setTimeout(() => {}, 10);
// oxlint-disable-next-line no-real-timer-waits-in-tests/no-real-timer-waits-in-tests -- fixture
setInterval(() => {}, 10);
// oxlint-disable-next-line no-real-timer-waits-in-tests/no-real-timer-waits-in-tests -- fixture
globalThis.setTimeout(() => {}, 10);
// oxlint-disable-next-line no-real-timer-waits-in-tests/no-real-timer-waits-in-tests -- fixture
window.setInterval(() => {}, 10);
// oxlint-disable-next-line no-real-timer-waits-in-tests/no-real-timer-waits-in-tests -- fixture
self.setTimeout(() => {}, 10);
// oxlint-disable-next-line no-real-timer-waits-in-tests/no-real-timer-waits-in-tests -- fixture
await Bun.sleep(10);
// oxlint-disable-next-line no-real-timer-waits-in-tests/no-real-timer-waits-in-tests -- fixture
await delay(10);
// oxlint-disable-next-line no-real-timer-waits-in-tests/no-real-timer-waits-in-tests -- fixture
await timers.setTimeout(100);
// expect-clean: no-real-timer-waits-in-tests/no-real-timer-waits-in-tests
await wait(() => true, { timeout: 100 });
// expect-clean: no-real-timer-waits-in-tests/no-real-timer-waits-in-tests
fakeTimers.advanceBy(10);
// expect-clean: no-real-timer-waits-in-tests/no-real-timer-waits-in-tests
queueMicrotask(() => {});
// expect-clean: no-real-timer-waits-in-tests/no-real-timer-waits-in-tests
await Promise.resolve();

import { setTimeout as unprefixedDelay } from "timers/promises";
// oxlint-disable-next-line no-real-timer-waits-in-tests/no-real-timer-waits-in-tests -- fixture
await unprefixedDelay(10);
const nestedDelay = delay;
const waitLater = () => {
  // oxlint-disable-next-line no-real-timer-waits-in-tests/no-real-timer-waits-in-tests -- fixture
  void nestedDelay(10);
};
void waitLater;
{
  const setTimeout = () => undefined;
  // expect-clean: no-real-timer-waits-in-tests/no-real-timer-waits-in-tests
  setTimeout();
}
const timerHost = { setTimeout: () => undefined };
// expect-clean: no-real-timer-waits-in-tests/no-real-timer-waits-in-tests
timerHost.setTimeout();
