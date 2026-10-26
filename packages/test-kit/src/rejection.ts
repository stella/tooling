import { panic } from "better-result";

/**
 * Awaits `promise` and returns the reason it rejected with, so a test asserts
 * on the rejection with a plain `expect`:
 *
 * ```ts
 * expect(await rejectionOf(load("missing"))).toBeInstanceOf(NotFoundError);
 * ```
 *
 * Unlike `expect(promise).rejects`, the assertion cannot settle after the test
 * ends. A promise that resolves instead fails the test with the resolved value
 * in the message.
 */
export const rejectionOf = async (
  promise: PromiseLike<unknown>,
): Promise<unknown> =>
  await promise.then(
    (value) =>
      panic(
        `Expected a rejection, but the promise resolved with ${Bun.inspect(value)}`,
      ),
    (error: unknown) => error,
  );
