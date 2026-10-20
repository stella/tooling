import { expect, test } from "bun:test";

import { withFakeServer } from "./fake-server.ts";
import { installNetworkGuard } from "./network.ts";

test("records requests and works through the network guard", async () => {
  const uninstall = installNetworkGuard();
  try {
    await withFakeServer(
      () => new Response("ok"),
      async ({ baseUrl, requests }) => {
        expect(
          await (
            await fetch(`${baseUrl}/path`, { body: "hello", method: "POST" })
          ).text(),
        ).toBe("ok");
        expect(requests).toHaveLength(1);
        expect(requests[0]?.method).toBe("POST");
        expect(new TextDecoder().decode(requests[0]?.body)).toBe("hello");
      },
    );
  } finally {
    uninstall();
  }
});

test("stops the server after a thrown test body", async () => {
  let url = "";
  expect(
    withFakeServer(
      () => new Response(),
      ({ baseUrl }) => {
        url = baseUrl;
        throw new Error("boom");
      },
    ),
  ).rejects.toThrow("boom");
  expect(fetch(url)).rejects.toThrow();
});

test("records concurrent requests in arrival order", async () => {
  await withFakeServer(
    () => new Response("ok"),
    async ({ baseUrl, requests }) => {
      let closeFirstBody: (() => void) | undefined;
      const firstBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first"));
          closeFirstBody = () => controller.close();
        },
      });
      const first = fetch(`${baseUrl}/first`, {
        body: firstBody,
        method: "POST",
      });
      while (requests.length === 0)
        await new Promise((resolve) => setImmediate(resolve));
      const second = fetch(`${baseUrl}/second`, {
        body: "second",
        method: "POST",
      });
      await second;
      closeFirstBody?.();
      await first;
      expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
        "/first",
        "/second",
      ]);
    },
  );
});
