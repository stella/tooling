import { panic } from "../src/invariant.js";

export const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    (value) =>
      panic(
        `Expected a rejection, but the promise resolved with ${String(value)}`,
      ),
    (error: unknown) => error,
  );
