import { expect, test } from "bun:test";

import { resolvedViteTarget } from "./publish-build-target-vite";

test("Vite final transform overrides take precedence, including explicit undefined", () => {
  for (const [target, expected] of [
    ["es2022", ["es2022"]],
    [undefined, ["esnext"]],
    [
      ["node22", "es2022", "node22"],
      ["es2022", "node22"],
    ],
  ] as const)
    expect(
      resolvedViteTarget({
        build: { target: "es2020", rolldownOptions: { transform: { target } } },
      }),
    ).toEqual({ type: "javascript", targets: expected });
  expect(resolvedViteTarget({ build: { target: false } })).toEqual({
    type: "javascript",
    targets: ["esnext"],
  });
  expect(
    resolvedViteTarget({ build: { target: ["chrome111", "safari16.4"] } }),
  ).toEqual({ type: "javascript", targets: ["chrome111", "safari16.4"] });
});

test("Vite unsupported resolved shapes fail before target classification", () => {
  for (const config of [
    {},
    { build: { target: [] } },
    { build: { target: null } },
    { builder: {}, build: {} },
    { build: { rolldownOptions: [] } },
    { build: { rolldownOptions: { transform: () => ({}) } } },
    { build: { rolldownOptions: { transform: { target: false } } } },
  ])
    expect(() => resolvedViteTarget(config)).toThrow();
});
