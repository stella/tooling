/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import policy from "../toolchain.json";
import { parseToolchainPolicy } from "./toolchain-schema";

test("Node policy permits canonical major series only", () => {
  for (const node of ["26.x", "27.x"])
    expect(parseToolchainPolicy({ ...policy, node }).node).toBe(node);
  for (const node of [
    "latest",
    "^26",
    ">=26",
    "26.*",
    "26",
    "v26.x",
    "026.x",
    "9007199254740992.x",
    "26.X",
    "26.x ",
    "26.1.x",
    "26.x || 24.x",
    "24.15.0",
    "26.0.0",
    "26.1.2",
    undefined,
    null,
    26,
  ])
    expect(() => parseToolchainPolicy({ ...policy, node })).toThrow(
      /Node|node/,
    );
});

test("policy retains every declared compiler command", () => {
  expect(
    parseToolchainPolicy(policy).typescriptInstallLayouts.map(
      ({ typecheckCommand }) => typecheckCommand,
    ),
  ).toEqual(
    policy.typescriptInstallLayouts.map(
      ({ typecheckCommand }) => typecheckCommand,
    ),
  );
});

test("each layout requires a nonempty compiler command", () => {
  for (const [index] of policy.typescriptInstallLayouts.entries()) {
    for (const typecheckCommand of [undefined, "", "   ", null, 42]) {
      const mutated = {
        ...policy,
        typescriptInstallLayouts: [
          ...policy.typescriptInstallLayouts.slice(0, index),
          { ...policy.typescriptInstallLayouts.at(index), typecheckCommand },
          ...policy.typescriptInstallLayouts.slice(index + 1),
        ],
      };
      expect(() => parseToolchainPolicy(mutated)).toThrow("typecheckCommand");
    }
  }
});
