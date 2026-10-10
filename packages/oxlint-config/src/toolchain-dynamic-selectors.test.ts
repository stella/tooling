/// <reference types="bun-types" />
import { expect, test } from "bun:test";

import toolchain from "../toolchain.json";
import { parseDynamicSelectors } from "./toolchain-dynamic-selectors";
import { checkRuntimeFile } from "./toolchain-runtime";
import { parseToolchainPolicy } from "./toolchain-schema";

const policy = parseToolchainPolicy(toolchain);
const action = (id: string) => {
  const pin = policy.actions[id];
  if (pin === undefined) throw new Error(`Missing action ${id}`);
  return `${id}@${pin.sha} # ${pin.version}`;
};
const file = ".github/workflows/example.yml";
const check = (text: string, decisions: unknown = []) => {
  const matched: unknown[] = [];
  const diagnostics = checkRuntimeFile({
    file,
    text,
    policy,
    trackedFiles: new Set(["package.json"]),
    readFile: () => JSON.stringify({ packageManager: `bun@${policy.bun}` }),
    dynamicSelectors: parseDynamicSelectors(decisions),
    onDynamicSelector: (entry) => matched.push(entry),
  });
  return { diagnostics, matched };
};
const imageDecision = {
  path: file,
  at: "jobs.example.container",
  kind: "image",
  reason: "Image selected by the scoped producer",
};
const bunDecision = {
  path: file,
  at: "jobs.example.steps.setup",
  kind: "bun-source",
  reason: "Manifest selected from the owned source snapshot",
};

test("dynamic image decisions apply to one job and never to literal pins", () => {
  const source =
    "jobs:\n  example:\n    container: '${{ needs.build.outputs.image }}'\n  other:\n    container: '${{ vars.IMAGE }}'\n";
  expect(check(source).diagnostics).toHaveLength(2);
  const declared = check(source, [imageDecision]);
  expect(declared.diagnostics).toMatchObject([
    { rule: "runtime-docker", line: 5 },
  ]);
  expect(declared.matched).toEqual([imageDecision]);
  expect(
    check(
      source.replace("${{ needs.build.outputs.image }}", "oven/bun:0.1.0"),
      [imageDecision],
    ).matched,
  ).toEqual([]);
  expect(
    check(
      source.replace("${{ needs.build.outputs.image }}", "oven/bun:0.1.0"),
      [imageDecision],
    ).diagnostics,
  ).toHaveLength(2);
});

test("current source checkout refs support local actions; foreign refs do not", () => {
  for (const ref of [
    undefined,
    "${{ github.sha }}",
    "${{ github.event.pull_request.head.sha }}",
    "${{ github.event.pull_request.head.sha || github.sha }}",
  ]) {
    const source = `jobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n${ref === undefined ? "" : `        with: {ref: '${ref}'}\n`}      - uses: ./.github/actions/example\n`;
    expect(check(source).diagnostics, ref).toEqual([]);
    const foreign = `jobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n        with: {repository: example/foreign${ref === undefined ? "" : `, ref: '${ref}'`}}\n      - uses: ./.github/actions/example\n`;
    expect(
      check(foreign).diagnostics.some(({ rule }) => rule === "action-pins"),
    ).toBe(true);
  }
});

test("Bun-source decisions cover expressions but never foreign checkout provenance", () => {
  const setup = `      - id: setup\n        uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: '\${{ inputs.manifest }}'}\n`;
  const source = `jobs:\n  example:\n    steps:\n${setup}`;
  expect(check(source).diagnostics).toMatchObject([{ rule: "bun-pins" }]);
  expect(check(source, [bunDecision])).toEqual({
    diagnostics: [],
    matched: [bunDecision],
  });
  for (const binding of [
    "repository: example/foreign, ref: main",
    "ref: main",
  ]) {
    const foreign = `jobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n        with: {${binding}}\n${setup}`;
    expect(
      check(foreign, [bunDecision]).diagnostics.some(
        ({ rule }) => rule === "bun-pins",
      ),
    ).toBe(true);
    expect(check(foreign, [bunDecision]).matched).toEqual([]);
  }
});

test("Bun-source decisions acknowledge same-repository dynamic checkout ambiguity", () => {
  const source = `jobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n      - uses: ${action("actions/checkout")}\n        with: {ref: '\${{ needs.build.outputs.source_sha }}'}\n      - id: setup\n        uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: package.json}\n`;
  expect(check(source).diagnostics).toMatchObject([{ rule: "bun-pins" }]);
  expect(check(source, [bunDecision])).toEqual({
    diagnostics: [],
    matched: [bunDecision],
  });
  expect(
    check(source.replace("needs.build.outputs.source_sha", "'main'"), [
      bunDecision,
    ]).matched,
  ).toEqual([]);
});

test("dynamic selector schema requires exact paths, locators, kinds and reasons", () => {
  expect(parseDynamicSelectors([imageDecision, bunDecision])).toHaveLength(2);
  for (const entry of [
    { ...imageDecision, path: "../example.yml" },
    { ...imageDecision, path: "/example.yml" },
    { ...imageDecision, path: "*.yml" },
    { ...imageDecision, reason: " " },
    { ...imageDecision, kind: "unknown" },
    { ...imageDecision, at: "jobs.*.container" },
    { ...imageDecision, line: 1 },
    { ...imageDecision, at: undefined, line: 0 },
    { ...imageDecision, extra: true },
  ])
    expect(() => parseDynamicSelectors([entry])).toThrow();
  expect(() => parseDynamicSelectors([imageDecision, imageDecision])).toThrow();
});

test("line declarations and service IDs stay scoped to their unresolved selector", () => {
  const source =
    "jobs:\n  example:\n    services:\n      database:\n        image: '${{ vars.DATABASE_IMAGE }}'\n      cache:\n        image: '${{ vars.CACHE_IMAGE }}'\n";
  for (const location of [
    { line: 5 },
    { at: "jobs.example.services.database" },
  ]) {
    const declaration = {
      path: file,
      kind: "image",
      reason: "Scoped service producer",
      ...location,
    };
    const result = check(source, [declaration]);
    expect(result.matched).toEqual([declaration]);
    expect(result.diagnostics).toMatchObject([
      { rule: "runtime-docker", line: 7 },
    ]);
  }
  const sourceBun = `jobs:\n  example:\n    steps:\n      - uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: '\${{ inputs.manifest }}'}\n`;
  expect(
    check(sourceBun, [
      {
        path: file,
        kind: "bun-source",
        line: 5,
        reason: "Scoped manifest producer",
      },
    ]).diagnostics,
  ).toEqual([]);
});

test("declared Bun selectors retain literal version and action-source checks", () => {
  const setup = `      - id: setup\n        uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: package.json}\n`;
  const source = `jobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n${setup}`;
  expect(check(source, [bunDecision]).matched).toEqual([]);
  for (const options of [
    "repository: example/foreign, ref: '${{ inputs.ref }}'",
    "ref: main",
  ]) {
    const invalid = source.replace(
      `      - uses: ${action("actions/checkout")}\n`,
      `      - uses: ${action("actions/checkout")}\n        with: {${options}}\n`,
    );
    expect(
      check(invalid, [bunDecision]).diagnostics.some(
        ({ rule }) => rule === "bun-pins",
      ),
    ).toBe(true);
    expect(check(invalid, [bunDecision]).matched).toEqual([]);
  }
});

test("unrelated dynamic checkouts cannot authorize static sparse omissions", () => {
  const source = `jobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n        with: {path: snapshot, ref: '\${{ inputs.ref }}'}\n      - uses: ${action("actions/checkout")}\n        with: {sparse-checkout: src}\n      - id: setup\n        uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: package.json}\n`;
  expect(check(source, [bunDecision]).matched).toEqual([]);
  expect(check(source, [bunDecision]).diagnostics).toMatchObject([
    { rule: "bun-pins" },
  ]);
});

test("Docker line decisions cover unresolved FROM values only", () => {
  const declaration = parseDynamicSelectors([
    {
      path: "Dockerfile",
      line: 2,
      kind: "image",
      reason: "Build supplies a digest-qualified image",
    },
  ]);
  const checkDocker = (text: string) => {
    const matched: unknown[] = [];
    const diagnostics = checkRuntimeFile({
      file: "Dockerfile",
      text,
      policy,
      trackedFiles: new Set(),
      readFile: () => undefined,
      dynamicSelectors: declaration,
      onDynamicSelector: (entry) => matched.push(entry),
    });
    return { diagnostics, matched };
  };
  expect(checkDocker("ARG IMAGE\nFROM $IMAGE AS base\nFROM base\n")).toEqual({
    diagnostics: [],
    matched: declaration,
  });
  const literal = checkDocker("ARG IMAGE=oven/bun:0.1.0\nFROM $IMAGE\n");
  expect(literal.matched).toEqual([]);
  expect(literal.diagnostics).toMatchObject([{ rule: "runtime-docker" }]);
});
