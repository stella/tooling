export type RecordedRequest = {
  body: Uint8Array;
  headers: readonly (readonly [string, string])[];
  method: string;
  url: string;
};
export type FakeServer = { baseUrl: string; requests: RecordedRequest[] };

export const withFakeServer = async <T>(
  handler: (request: Request) => Response | Promise<Response>,
  fn: (server: FakeServer) => T | Promise<T>,
): Promise<T> => {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const copy = request.clone();
      const recordedRequest = {
        body: new Uint8Array(),
        headers: Array.from(copy.headers.entries()),
        method: copy.method,
        url: copy.url,
      };
      requests.push(recordedRequest);
      recordedRequest.body = new Uint8Array(await copy.arrayBuffer());
      return await handler(request);
    },
  });
  try {
    return await fn({
      baseUrl: `http://127.0.0.1:${String(server.port)}`,
      requests,
    });
  } finally {
    await server.stop(true);
  }
};
