import { mock } from "bun:test";
import net from "node:net";
import * as netNamespace from "node:net";
import tls from "node:tls";
import * as tlsNamespace from "node:tls";

import { installNetworkGuard } from "../network.js";

installNetworkGuard();

// Bun's builtin named exports do not follow mutations to the default object.
// Resolve guarded factories before consumer test modules load; these overrides
// share the preload's process lifetime and retain the original default objects.
const guardedNetExports = {
  ...netNamespace,
  default: net,
  connect: net.connect,
  createConnection: net.createConnection,
};
const guardedTlsExports = {
  ...tlsNamespace,
  default: tls,
  connect: tls.connect,
};
mock.module("node:net", () => guardedNetExports);
mock.module("net", () => guardedNetExports);
mock.module("node:tls", () => guardedTlsExports);
mock.module("tls", () => guardedTlsExports);
