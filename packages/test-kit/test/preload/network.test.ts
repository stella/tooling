import net from "node:net";

import { installNetworkGuard, NetworkAccessError } from "../../src/network.js";
import { rejectionOf } from "../rejection.js";
import { expect, test } from "../runner.js";

test("the configured setup guards fetch and sockets before tests run", async () => {
  expect(() => installNetworkGuard()).toThrow("already installed");
  expect(await rejectionOf(fetch("https://example.com/"))).toBeInstanceOf(
    NetworkAccessError,
  );
  expect(() => net.connect({ host: "203.0.113.7", port: 443 })).toThrow(
    NetworkAccessError,
  );
});
