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
  await expect(
    withFakeServer(
      () => new Response(),
      ({ baseUrl }) => {
        url = baseUrl;
        throw new Error("boom");
      },
    ),
  ).rejects.toThrow("boom");
  await expect(fetch(url)).rejects.toThrow();
});
