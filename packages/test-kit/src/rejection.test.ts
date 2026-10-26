import { Panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "./index.ts";

describe("rejectionOf", () => {
  test("returns the exact reason a promise rejects with", async () => {
    const reason = new TypeError("bad input");
    expect(await rejectionOf(Promise.reject(reason))).toBe(reason);
    expect(await rejectionOf(Promise.reject("plain string"))).toBe(
      "plain string",
    );
  });

  test("waits for a rejection that happens later", async () => {
    const { promise, reject } = Promise.withResolvers<never>();
    const pending = rejectionOf(promise);
    const reason = new Error("late");
    reject(reason);
    expect(await pending).toBe(reason);
  });

  test("fails with the resolved value when the promise resolves", async () => {
    const failure = await rejectionOf(
      rejectionOf(Promise.resolve({ id: 42, state: "done" })),
    );
    expect(failure).toBeInstanceOf(Panic);
    expect(String(failure)).toContain(
      "Expected a rejection, but the promise resolved with",
    );
    expect(String(failure)).toContain("id: 42");
    expect(String(failure)).toContain('state: "done"');
  });
});
