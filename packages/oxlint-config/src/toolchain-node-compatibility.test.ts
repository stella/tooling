import { expect, test } from "bun:test";
import { stringify } from "yaml";

import {
  type NodeCompatibility,
  nodeCompatibilityProblem,
  parseNodeCompatibility,
} from "./toolchain-node-compatibility";
import { checkRuntimeFile } from "./toolchain-runtime";

const entry = {
  package: "packages/cli",
  workflow: ".github/workflows/publish.yml",
  job: "pack",
  step: "node-smoke",
  version: "22.23.4",
  reason: "Smoke-test the packed CLI on a supported older Node major.",
} satisfies NodeCompatibility;
const sha = "a".repeat(40);
const action = {
  id: entry.step,
  uses: `actions/setup-node@${sha}`,
  with: { "node-version": entry.version },
};
const check = (steps: unknown[], declarations = [entry]) => {
  const matches: NodeCompatibility[] = [];
  const diagnostics = checkRuntimeFile({
    file: entry.workflow,
    text: stringify({ jobs: { pack: { steps } } }).replaceAll(
      `actions/setup-node@${sha}`,
      `actions/setup-node@${sha} # v7`,
    ),
    policy: {
      node: "26.x",
      bun: "1.4.4",
      rust: "1.99.1",
      python: "3.13.7",
      packages: {},
      actions: { "actions/setup-node": { sha, version: "v7" } },
    },
    trackedFiles: new Set(),
    readFile: () => undefined,
    nodeCompatibility: declarations,
    onNodeCompatibility: (match) => matches.push(match),
  });
  return { diagnostics, matches };
};

test("compatibility pins are exact and within a published package's engine range", () => {
  const files = {
    [entry.workflow]: "jobs: {}",
    "packages/cli/package.json": JSON.stringify({
      name: "@example/cli",
      engines: { node: ">=20" },
    }),
  };
  expect(parseNodeCompatibility([entry])).toEqual([entry]);
  expect(nodeCompatibilityProblem(entry, files)).toBeUndefined();
  for (const manifest of [
    { name: "@example/cli", private: true, engines: { node: ">=20" } },
    { name: "@example/cli", engines: { node: ">=24" } },
    { name: "@example/cli", engines: { node: "not a range" } },
    { name: "@example/cli" },
    {},
  ])
    expect(
      nodeCompatibilityProblem(entry, {
        ...files,
        "packages/cli/package.json": JSON.stringify(manifest),
      }),
    ).toBeDefined();
  expect(nodeCompatibilityProblem(entry, {})).toBeDefined();
  expect(
    nodeCompatibilityProblem(entry, {
      ...files,
      "packages/cli/package.json": "{",
    }),
  ).toBeDefined();
  for (const version of [
    "22",
    "22.x",
    "22.23",
    "v22.23.4",
    "22.23.4-rc.1",
    "022.23.4",
    "${{ inputs.node }}",
  ])
    expect(() => parseNodeCompatibility([{ ...entry, version }])).toThrow();
});

test("declarations cannot become broad runtime exemptions", () => {
  for (const field of ["package", "workflow", "job", "step", "reason"])
    expect(() => parseNodeCompatibility([{ ...entry, [field]: "" }])).toThrow();
  expect(() => parseNodeCompatibility([entry, entry])).toThrow();
  expect(() => parseNodeCompatibility([{ ...entry, extra: true }])).toThrow();
  expect(check([action])).toEqual({ diagnostics: [], matches: [entry] });
  expect(check([action], []).diagnostics.length).toBeGreaterThan(0);
  expect(
    check([{ ...action, id: "different" }]).diagnostics.length,
  ).toBeGreaterThan(0);
  for (const inputs of [
    { "node-version": "22.23.3" },
    { "node-version": "${{ env.NODE_VERSION }}" },
    { "node-version-file": ".node-version" },
    { "node-version": entry.version, "node-version-file": ".node-version" },
  ]) {
    const result = check([{ ...action, with: inputs }]);
    expect(result.matches).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  }
  expect(check([action, action]).matches).toHaveLength(2);
  expect(
    check([
      { ...action, uses: `actions/setup-node@${"b".repeat(40)}` },
    ]).diagnostics.some((finding) => finding.rule === "action-pins"),
  ).toBe(true);
});
