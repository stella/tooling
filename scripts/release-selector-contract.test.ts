/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import {
  releasePolicyRef,
  validateSelectorContract,
} from "../packages/oxlint-config/src/release-selector-contract";

const actions = {
  "actions/setup-node": { sha: "1".repeat(40) },
  "oven-sh/setup-bun": { sha: "2".repeat(40) },
  "actions/setup-python": { sha: "3".repeat(40) },
  "actions/checkout": { sha: "4".repeat(40) },
};
const selectors = () =>
  new Set(
    Object.entries(actions)
      .filter(([name]) => name !== "actions/checkout")
      .map(([name, { sha }]) => `${name}@${sha}`),
  );

test("selector contract accepts exactly the three installed action pins", () => {
  expect(() =>
    validateSelectorContract({ selectors: selectors(), actions }),
  ).not.toThrow();
});

test("every selector rejects omission, divergence and extra entries", () => {
  for (const original of selectors()) {
    const missing = selectors();
    missing.delete(original);
    expect(() =>
      validateSelectorContract({ selectors: missing, actions }),
    ).toThrow("missing");
    const divergent = new Set([
      ...missing,
      original.replace(/@[a-f0-9]+$/, `@${"5".repeat(40)}`),
    ]);
    expect(() =>
      validateSelectorContract({ selectors: divergent, actions }),
    ).toThrow("extra");
    const extra = new Set([
      ...selectors(),
      original.replace(/@[a-f0-9]+$/, "@v1"),
    ]);
    expect(() =>
      validateSelectorContract({ selectors: extra, actions }),
    ).toThrow("extra");
  }
});

test("selector registry shape and policy pins fail closed", () => {
  for (const registry of [undefined, [], {}, "pins", new Set([42])])
    expect(() =>
      validateSelectorContract({ selectors: registry, actions }),
    ).toThrow("string Set");
  for (const name of [
    "actions/setup-node",
    "oven-sh/setup-bun",
    "actions/setup-python",
  ])
    for (const sha of ["1".repeat(39), "1".repeat(41), "v7", "G".repeat(40)])
      expect(() =>
        validateSelectorContract({
          selectors: selectors(),
          actions: { ...actions, [name]: { sha } },
        }),
      ).toThrow("full SHA");
  expect(() =>
    validateSelectorContract({ selectors: selectors(), actions: {} }),
  ).toThrow("full SHA");
});

const workflow = (uses: string) => `jobs:
  enforce:
    uses: ${uses}
`;
const sharedWorkflow = "stella/.github/.github/workflows/release-policy.yml";
test("shared checkout ref derives from the existing full SHA workflow reference", () => {
  const sha = "abcdef0123456789".repeat(2) + "abcdef01";
  expect(releasePolicyRef(workflow(`${sharedWorkflow}@${sha}`))).toBe(sha);
  expect(
    releasePolicyRef(`jobs: { enforce: { uses: '${sharedWorkflow}@${sha}' } }`),
  ).toBe(sha);
});

test("shared checkout ref rejects tags, malformed refs and different consumers", () => {
  for (const source of ["{}", "[]", "jobs: {}", "jobs: { enforce: {} }"])
    expect(() => releasePolicyRef(source)).toThrow();
  for (const ref of [
    "v1",
    "main",
    "1".repeat(39),
    "1".repeat(41),
    "G".repeat(40),
    "${{ inputs.ref }}",
  ])
    expect(() =>
      releasePolicyRef(workflow(`${sharedWorkflow}@${ref}`)),
    ).toThrow();
  for (const name of [
    "other/.github/.github/workflows/release-policy.yml",
    "stella/.github/.github/workflows/other.yml",
  ])
    expect(() =>
      releasePolicyRef(workflow(`${name}@${"1".repeat(40)}`)),
    ).toThrow();
});
