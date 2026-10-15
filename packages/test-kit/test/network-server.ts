import { createServer, type RequestListener } from "node:http";

/** A real loopback HTTP server shared by the Node and Bun test runs. */
export const serve = async (
  handler: (...args: Parameters<RequestListener>) => unknown,
) => {
  const handlerFailures: unknown[] = [];
  const server = createServer((request, response) => {
    // Node ignores listener promises; retain failures until awaited teardown.
    void Promise.resolve()
      .then(() => handler(request, response))
      .catch((error: unknown) => {
        handlerFailures.push(error);
        response.destroy();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Loopback server did not acquire a TCP port");
  }
  return {
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      if (handlerFailures.length > 0) {
        throw new Error("Loopback server handler failed", {
          cause: handlerFailures.at(0),
        });
      }
    },
  };
};
