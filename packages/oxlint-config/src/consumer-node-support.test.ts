import { expect, test } from "bun:test";

import { consumerNodeSupportMatches } from "./consumer-node-support";

test("consumer Node support is unrestricted only when no Node range is declared", () => {
  const node = "22.21.1";
  for (const range of [undefined, "*", ">=20", "^22.0.0"])
    expect(consumerNodeSupportMatches({ range, node })).toBe(true);
  for (const range of [null, 22, "", "latest", ">=24", "<22", "22.21.0"])
    expect(consumerNodeSupportMatches({ range, node })).toBe(false);
});
