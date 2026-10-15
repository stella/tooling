import bareNet, {
  connect as bareConnect,
  createConnection as bareCreateConnection,
} from "net";
import { createRequire } from "node:module";
import net, { connect, createConnection, Socket } from "node:net";
import tls, { connect as tlsConnect } from "node:tls";
import bareTls, { connect as bareTlsConnect } from "tls";

const require = createRequire(import.meta.url);
const remote = { host: "203.0.113.7", port: 443 };
const requireSocketConnector = (specifier: string) => {
  const module: unknown = require(specifier);
  if (
    (typeof module !== "object" || module === null) &&
    typeof module !== "function"
  ) {
    throw new Error(`Socket fixture module ${specifier} must export an object`);
  }
  const factory: unknown = Reflect.get(module, "connect");
  if (typeof factory !== "function") {
    throw new Error(`Socket fixture module ${specifier} must export connect`);
  }
  return () => {
    Reflect.apply(factory, module, [remote]);
  };
};
const requiredNet = requireSocketConnector("node:net");
const requiredBareNet = requireSocketConnector("net");
const requiredTls = requireSocketConnector("node:tls");
const requiredBareTls = requireSocketConnector("tls");

/** Imported after setup, just as a dependency retaining a socket factory would be. */
export const socketImports = [
  { name: "node:net named connect", connect: () => connect(remote) },
  {
    name: "node:net named createConnection",
    connect: () => createConnection(remote),
  },
  { name: "node:net default", connect: () => net.connect(remote) },
  { name: "net named connect", connect: () => bareConnect(remote) },
  {
    name: "net named createConnection",
    connect: () => bareCreateConnection(remote),
  },
  { name: "net default", connect: () => bareNet.connect(remote) },
  { name: "node:tls named connect", connect: () => tlsConnect(remote) },
  { name: "node:tls default", connect: () => tls.connect(remote) },
  { name: "tls named connect", connect: () => bareTlsConnect(remote) },
  { name: "tls default", connect: () => bareTls.connect(remote) },
  { name: "require node:net", connect: requiredNet },
  { name: "require net", connect: requiredBareNet },
  { name: "require node:tls", connect: requiredTls },
  { name: "require tls", connect: requiredBareTls },
  {
    name: "named Socket prototype",
    connect: () => new Socket().connect(remote),
  },
];
