import { expect, test } from "bun:test";

import { repositoryBun, satisfiesBunFloor } from "./toolchain-bun";

test("the repository Bun is its exact root pin at or above the shared minimum", () => {
  const manifest = (packageManager: unknown) =>
    JSON.stringify({ packageManager });
  expect(repositoryBun("1.4.4", manifest("bun@1.4.4"))).toBe("1.4.4");
  expect(repositoryBun("1.4.4", manifest("bun@1.4.5"))).toBe("1.4.5");
  expect(repositoryBun("1.4.4", manifest("bun@1.5.0"))).toBe("1.5.0");
  for (const below of [
    manifest("bun@1.4.3"),
    manifest("bun@1.4"),
    manifest("bun@^1.4.5"),
    manifest("bun@1.4.5-canary.1"),
    manifest("pnpm@10.0.0"),
    manifest(undefined),
    "not json",
    undefined,
  ])
    expect(repositoryBun("1.4.4", below)).toBe("1.4.4");
});

test("a selected runtime meets the floor only as an exact later release", () => {
  expect(satisfiesBunFloor("1.4.4", "1.4.4")).toBe(true);
  expect(satisfiesBunFloor("1.5.0", "1.4.4")).toBe(true);
  expect(satisfiesBunFloor("1.4.3", "1.4.4")).toBe(false);
  expect(satisfiesBunFloor("1.4.5-canary.1", "1.4.4")).toBe(false);
  expect(satisfiesBunFloor("", "1.4.4")).toBe(false);
});
