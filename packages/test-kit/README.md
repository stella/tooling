# @stll/test-kit

Deterministic clocks, observable waits, private temporary directories, and network guards for Bun and Vitest tests. The root import has no runner hooks or setup side effects. Requires Bun 1.4.3+ or Node 22.23.3+.

```sh
bun add --dev @stll/test-kit
# or
npm install --save-dev @stll/test-kit
```

| Need                                | Primitive                                                     |
| ----------------------------------- | ------------------------------------------------------------- |
| Advance time explicitly             | `createTestClock`, `Clock`, `systemClock`                     |
| Signal a state transition           | `deferred`, `waitForEvent`, `waitForAbort`                    |
| Observe state that has no event     | `waitFor(probe, { description })`                             |
| Fail a hung promise with context    | `settledWithin(promise, { description })`, `WaitTimeoutError` |
| Own a temporary directory           | `createTestTmpDir`, `withTestTmpDir`, `createTestTmpDirSlot`  |
| Refuse unintended external requests | `installNetworkGuard`, `NetworkAccessError`, `isLoopbackHost` |
| Use the database's time             | `dbClock`, `clockTimestamp` from `@stll/test-kit/drizzle`     |

## Clock and waits

Pass a `Clock` to code that reads time or waits. Use `systemClock` for real time and `createTestClock()` in tests. A test clock starts at a fixed instant; `advance(ms)` wakes sleepers in deadline order and runs the work they schedule before advancing again. `setTime()` changes wall time without moving monotonic time.

```ts
import { createTestClock, deferred, settledWithin } from "@stll/test-kit";

const clock = createTestClock();
const ready = deferred<string>();
const outcome = settledWithin(ready.promise, {
  description: "worker readiness",
  clock,
});
ready.resolve("ready");
console.log(await outcome); // ready
await clock.advance(100);
```

`waitForEvent(target, type)` and `waitForAbort(signal)` observe events. `waitFor(probe, { description })` polls until the probe returns something other than `undefined`. Prefer an event or deferred when the producer can signal.

Waits have a 20-second default hang deadline, which can use either clock. A deadline detects a stuck test; use work counts to assert efficiency rather than shortening it to measure speed. Probe failures and abort reasons propagate to the caller.

## Bun

```toml
# bunfig.toml
[test]
preload = ["@stll/test-kit/bun/forbid-network"]
```

```ts
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";

import { useTestTmpDir } from "@stll/test-kit/bun";

const tmp = useTestTmpDir("example");
test("writes an artifact", async () => {
  await writeFile(tmp().join("artifact.txt"), "ready");
  expect(tmp().path).toBeTruthy();
});
```

## Vitest

Install Vitest separately; it is an optional peer dependency.

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["@stll/test-kit/vitest/forbid-network"] },
});
```

Use `useTestTmpDir` from `@stll/test-kit/vitest` with Vitest's `test` and `expect`. Each adapter creates a directory before a test and removes it afterwards, including after failures. These hook adapters serve sequential tests; concurrent tests use `withTestTmpDir` inside each test instead.

## Temporary directories without hooks

```ts
import { writeFile } from "node:fs/promises";

import { withTestTmpDir } from "@stll/test-kit";

await withTestTmpDir(async (tmp) => {
  await writeFile(tmp.join("artifact.txt"), "ready");
});
```

`await using tmp = await createTestTmpDir()` provides scope cleanup where explicit resource management is supported. Otherwise call `remove()` in `finally`. `createTestTmpDirSlot` exposes `open`, `current`, and `close` for custom lifecycle adapters. `join` refuses paths outside the directory; it is a path convenience, not a sandbox against symlinks or untrusted filesystem actors.

## Network guard

The preload/setup entry points install the guard. For custom setup, call `installNetworkGuard({ allowHosts: ["database"] })`; its return value uninstalls that instance. Only one instance may be installed at a time.

Bun tests need `@stll/test-kit/bun/forbid-network` as a preload to guard named socket imports. It registers the guarded `node:net`/`net` and `node:tls`/`tls` modules before test modules load, covering named imports, default imports, and `require`. Calling `installNetworkGuard()` directly under Bun is best effort: it patches transport objects, but Bun does not synchronize existing named socket imports. Node/Vitest synchronizes those imports during installation.

The guard covers `fetch` (including redirect hops), `node:net`, and `node:tls`. Under Bun it also covers `Bun.connect` and `fetch.preconnect`. Loopback addresses and local URL schemes remain available. Bun's `init.unix` keeps its Unix-socket behavior; Node ignores that extension and still checks the URL host. Additional hosts require explicit names. Remote proxy settings refuse installation; custom tests can pass an explicit `environment` map.

Socket calls must identify an allowed host or a non-empty Unix socket path. Normalized socket arguments are inspected too; unknown targets, including port-only calls, are refused.

Install before importing code that captures transport functions. The guard is a test backstop, not an operating-system network sandbox; it does not cover native clients or transports such as UDP and HTTP/2 that bypass these functions. The guard never clones or buffers request bodies. A `Request` with a body passes through untouched; a 307/308 redirect that needs to resend it fails with an explicit error: pass the body in `init` instead. Replayable `init.body` values follow redirects; a caller-supplied `ReadableStream` passes through untouched and cannot be resent. This bounded-memory contract also applies to string bodies already wrapped in a `Request`. Redirect responses retain the final hop's URL; `redirected` is false because the guard follows redirects itself.

## Drizzle database clock

Install `drizzle-orm` separately; it is an optional peer dependency. PostgreSQL and PGlite comparisons should use the database's `now()` rather than mixing it with a JavaScript timestamp.

```ts
import { dbClock } from "@stll/test-kit/drizzle";

await db.insert(jobs).values({ createdAt: dbClock.ago(60_000) });
```

`dbClock.now()`, `ago(ms)`, and `fromNow(ms)` return SQL expressions relative to transaction time. `clockTimestamp(clock, offsetMs)` renders an injected clock's instant as a `timestamptz` literal for queries that need the same clock as the test.
