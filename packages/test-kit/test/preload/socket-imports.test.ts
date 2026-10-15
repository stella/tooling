import { NetworkAccessError } from "../../src/network.js";
import { expect, test } from "../runner.js";
import { socketImports } from "./socket-import-fixture.js";

test.each(socketImports)(
  "setup guards $name imported by a consumer module",
  ({ connect }) => {
    expect(connect).toThrow(NetworkAccessError);
  },
);
