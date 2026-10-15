import {
  createTestClock,
  deferred,
  installNetworkGuard,
  settledWithin,
} from "../src/index.js";
import { expect, test } from "./runner.js";

test("the core import works without registering runner hooks or network setup", async () => {
  const clock = createTestClock();
  const ready = deferred<string>();
  ready.resolve("ready");
  expect(
    await settledWithin(ready.promise, { clock, description: "readiness" }),
  ).toBe("ready");
  const uninstall = installNetworkGuard({ environment: {} });
  uninstall();
});
