# @stll/test-kit

Hermetic, deterministic test primitives. A test built from these does not
depend on how fast the machine is, what time it is, which files a previous
run left behind, or whether the internet is reachable.

The kit runs under Bun's test runner (`bun test`). `drizzle-orm` is an optional
peer dependency, needed only by `@stll/test-kit/db`.

```sh
bun add -d @stll/test-kit
```

| Need                                            | Use                                                                                 | Instead of                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Time that moves only when the test says so      | `createTestClock()`; pass it where the code takes a `Clock`                         | `Date.now()`, `performance.now()`, `Bun.sleep`, `setTimeout` |
| Wait for something that happens                 | `deferred()`, `waitForEvent()`, `waitForAbort()`                                    | sleeping and hoping                                          |
| Wait for state without an event (a row, a file) | `waitFor(probe, { description })`                                                   | a hand-written poll loop                                     |
| A deadline that only catches hangs              | `settledWithin(promise, { description })`                                           | `Promise.race` with a short timer as an assertion            |
| A private directory per test                    | `useTestTmpDir()`, `withTestTmpDir()`, `await using dir = await createTestTmpDir()` | `mkdtemp(tmpdir())` and manual cleanup                       |
| No outbound network                             | preload `@stll/test-kit/forbid-network`, or `installNetworkGuard()`                 | relying on the CI network                                    |
| Database timestamps compared with `now()`       | `dbClock.ago(ms)` / `dbClock.fromNow(ms)` from `@stll/test-kit/db`                  | `new Date(Date.now() - ms)` written into a column            |
| Repeatable random data                          | `createSeededRandom(testSeed())`                                                    | `Math.random()`                                              |
| Timer-driven behavior                           | `withFakeTimers()` or `createFakeTimers()`                                          | real `setTimeout()` and `setInterval()`                      |
| HTTP dependencies                               | `withFakeServer()`                                                                  | the internet or shared services                              |
| Performance growth                              | `expectLinearScaling()`                                                             | absolute wall-clock budgets                                  |

## Performance scaling

Assert how work scales instead of requiring it to finish before an absolute
deadline. The helper warms up each size, calibrates every sample over a measurable window,
and compares per-call medians, so overall machine speed cancels out. Each consecutive
size ratio must be greater than `maxGrowthFactor` (2.5 by default); this ensures
quadratic growth exceeds the allowed linear-growth threshold. Choose sizes for the
slowest engine where the code runs: a quadratic implementation should show its growth
in the ratio before any single call becomes slow. For example, a Stella citation
extractor can measure successively longer citation-shaped strings:

```ts
import { expectLinearScaling } from "@stll/test-kit";

await expectLinearScaling({
  run: (size) => extractCitations(citationShape.repeat(size)),
  sizes: [1_000, 4_000, 16_000],
});
```

## Clock

`createTestClock()` starts at a fixed instant. `advance(ms)` wakes every due
sleeper in deadline order and lets the work it schedules run before the next
one wakes, so a periodic loop driven by the clock runs the same way on every
machine. `setTime()` changes only the wall clock, like a system clock change.

## Waits

Every wait takes a `description`. The hang guard (4 s by default, below
`bun test`'s default 5 s per-test timeout; give a wait its own `timeoutMs` when
a suite raises that timeout) fails with "waiting for <description>", so a stuck test
says what it was waiting for. The guard is never a statement about speed: do
not shorten it to assert that something is fast. Assert work counts instead.

## Database clock

Postgres compares rows with its own `now()`. A JavaScript timestamp written
into a column that the code compares with `now()` mixes two clocks.
`dbClock` builds those values from the database clock instead.

## Seeded randomness

`createSeededRandom(seed)` supplies `next()`, inclusive `int(min, max)`,
`pick(items)`, and a non-mutating `shuffle(items)`. `testSeed()` derives a stable
seed from its test call site unless `STLL_TEST_SEED` is set, and prints the seed.
Copy the printed assignment into the environment to reproduce a failure exactly.

## Fake timers

`createFakeTimers()` returns timer functions plus `advance(ms)` and `runAll()`.
They use a test clock and fire only when explicitly advanced. `withFakeTimers(fn)`
temporarily installs those functions on `globalThis`, then restores the real timer
functions even when `fn` throws. Code outside the callback is unaffected.

## Fake HTTP server

`withFakeServer(handler, fn)` binds an ephemeral port on `127.0.0.1`, passes
`{ baseUrl, requests }` to `fn`, records request metadata and bodies, and stops the
server afterward even when `fn` throws. Loopback remains available when the network
guard is installed.
