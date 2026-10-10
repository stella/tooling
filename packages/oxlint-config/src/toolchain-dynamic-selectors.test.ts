/// <reference types="bun-types" />
import { expect, test } from "bun:test";

import toolchain from "../toolchain.json";
import {
  parseDynamicSelectors,
  type DynamicSelector,
} from "./toolchain-dynamic-selectors";
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
} as const satisfies DynamicSelector;
const bunDecision = {
  path: file,
  at: "jobs.example.steps.setup",
  kind: "bun-source",
  reason: "Manifest selected from the owned source snapshot",
} as const satisfies DynamicSelector;

test("exact selector paths permit spaces without accepting control characters", () => {
  const path = ".github/workflows/release candidate.yml";
  const declaration = { ...imageDecision, path };
  expect(parseDynamicSelectors([declaration])).toEqual([declaration]);
  const matched: unknown[] = [];
  expect(
    checkRuntimeFile({
      file: path,
      text: "jobs:\n  example:\n    container: '${{ inputs.image }}'\n",
      policy,
      trackedFiles: new Set(),
      readFile: () => undefined,
      dynamicSelectors: parseDynamicSelectors([declaration]),
      onDynamicSelector: (entry) => matched.push(entry),
    }),
  ).toEqual([]);
  expect(matched).toEqual([declaration]);
  for (const control of ["\t", "\r", "\n", "\v", "\f"])
    expect(() =>
      parseDynamicSelectors([{ ...declaration, path: path + control }]),
    ).toThrow();
});

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
  for (const ref of [undefined, "${{ github.sha }}"]) {
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
  expect(literal.diagnostics).toMatchObject([{ rule: "bun-pins" }]);
});

test("event-specific source refs never classify a PR head as inspected source", () => {
  for (const event of [
    "push",
    "merge_group",
    "pull_request",
    "pull_request_target",
    "workflow_run",
  ]) {
    const source = (ref: string) =>
      `on: ${event}\njobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n        with: {ref: '${ref}'}\n      - uses: ./.github/actions/example\n`;
    expect(check(source("${{ github.sha }}")).diagnostics).toEqual([]);
    expect(check(source("${{ github.ref }}")).diagnostics).toMatchObject([
      { rule: "action-pins" },
    ]);
    for (const ref of [
      "${{ github.event.pull_request.head.sha }}",
      "${{ github.event.pull_request.head.ref }}",
      "${{ github.event.pull_request.head.sha || github.sha }}",
    ])
      expect(
        check(source(ref)).diagnostics.some(
          ({ rule }) => rule === "action-pins",
        ),
      ).toBe(true);
  }
});

test("dynamic refs retain static sparse requirements and root-anchored manifest paths", () => {
  const source = (sparse: string) =>
    `on: push\njobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n        with: {path: snapshot, ref: '\${{ inputs.ref }}', sparse-checkout: '${sparse}', sparse-checkout-cone-mode: false}\n      - id: setup\n        uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: snapshot/package.json}\n`;
  for (const sparse of ["src", "!package.json", "*.json"])
    expect(check(source(sparse), [bunDecision]).matched).toEqual([]);
  expect(check(source("/package.json")).diagnostics).toEqual([]);
  expect(check(source("${{ inputs.sparse }}"), [bunDecision])).toEqual({
    diagnostics: [],
    matched: [bunDecision],
  });
});

test("PR-head manifest selectors delegate without reading the inspected manifest", () => {
  for (const event of [
    "pull_request",
    "pull_request_target",
    "push",
    "merge_group",
  ])
    for (const ref of [
      "${{ github.event.pull_request.head.sha }}",
      "${{ github.event.pull_request.head.ref }}",
      "${{ github.event.pull_request.head.sha || github.sha }}",
    ]) {
      const reports: unknown[] = [];
      const diagnostics = checkRuntimeFile({
        file,
        text: `on: ${event}\njobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n        with: {ref: '${ref}'}\n      - uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: package.json}\n`,
        policy,
        trackedFiles: new Set(["package.json"]),
        readFile: () => {
          throw new Error(
            "Delegated manifests must not read the inspected source",
          );
        },
        onDelegated: (report) => reports.push(report),
      });
      expect(diagnostics).toEqual([]);
      expect(reports).toMatchObject([
        { tool: "bun", selector: "package.json", ref },
      ]);
    }
});

test("reusable workflow caller checkouts cannot authorize inspected local actions", () => {
  for (const trigger of [
    "workflow_call",
    "[workflow_call, push]",
    "{workflow_call: {}, push: {}}",
  ])
    for (const binding of [
      undefined,
      "repository: '${{ github.repository }}', ref: '${{ github.sha }}'",
    ]) {
      const source = `on: ${trigger}\njobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n${binding === undefined ? "" : `        with: {${binding}}\n`}      - uses: ./.github/actions/example\n`;
      expect(
        check(source).diagnostics.some(({ rule }) => rule === "action-pins"),
      ).toBe(true);
      const owned = source.replace(
        binding === undefined
          ? `      - uses: ./.github/actions/example`
          : `        with: {${binding}}`,
        binding === undefined
          ? "        with: {repository: '${{ job.workflow_repository }}', ref: '${{ job.workflow_sha }}'}\n      - uses: ./.github/actions/example"
          : "        with: {repository: '${{ job.workflow_repository }}', ref: '${{ job.workflow_sha }}'}",
      );
      expect(check(owned).diagnostics).toEqual([]);
    }
  const reports: unknown[] = [];
  expect(
    checkRuntimeFile({
      file,
      text: `on: workflow_call\njobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n        with: {repository: '\${{ github.repository }}', ref: '\${{ github.sha }}'}\n      - uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: package.json}\n`,
      policy,
      trackedFiles: new Set(["package.json"]),
      readFile: () => {
        throw new Error("Caller manifests must be delegated");
      },
      onDelegated: (report) => reports.push(report),
    }),
  ).toEqual([]);
  expect(reports).toMatchObject([{ tool: "bun", ref: "${{ github.sha }}" }]);
});

test("mixed sparse expressions cannot conceal literal invalid patterns", () => {
  for (const literal of [
    "!package.json",
    "*.json",
    "../package.json",
    "!${{ inputs.excluded }}",
  ])
    for (const entries of [
      [literal, "${{ inputs.sparse }}"],
      ["${{ inputs.sparse }}", literal],
    ]) {
      const source = `on: push\njobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n        with:\n          path: snapshot\n          ref: '\${{ inputs.ref }}'\n          sparse-checkout-cone-mode: false\n          sparse-checkout: |\n${entries.map((entry) => `            ${entry}\n`).join("")}      - id: setup\n        uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: snapshot/package.json}\n`;
      const result = check(source, [bunDecision]);
      expect(result.matched).toEqual([]);
      expect(result.diagnostics).toMatchObject([{ rule: "bun-pins" }]);
    }
});

test("default reusable checkout delegates caller manifests without inspected reads", () => {
  for (const trigger of [
    "workflow_call",
    "[workflow_call, push]",
    "{workflow_call: {}, push: {}}",
  ])
    for (const inputs of [
      "",
      "        with: {repository: '${{ github.repository }}'}\n",
    ]) {
      const reports: unknown[] = [];
      expect(
        checkRuntimeFile({
          file,
          text: `on: ${trigger}\njobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n${inputs}      - uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: package.json}\n`,
          policy,
          trackedFiles: new Set(["package.json"]),
          readFile: () => {
            throw new Error("Default caller checkout must delegate");
          },
          onDelegated: (report) => reports.push(report),
        }),
      ).toEqual([]);
      expect(reports).toMatchObject([
        { tool: "bun", ref: "${{ github.sha }}" },
      ]);
    }
});

test("expression-bearing sparse entries validate every literal fragment", () => {
  const source = (entry: string) =>
    `on: push\njobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n        with:\n          ref: '\${{ inputs.ref }}'\n          sparse-checkout-cone-mode: false\n          sparse-checkout: |\n            ${entry}\n      - id: setup\n        uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: package.json}\n`;
  for (const entry of [
    "*${{ inputs.suffix }}",
    "${{ inputs.prefix }}*.json",
    "[${{ inputs.pattern }}]",
    "../${{ inputs.file }}",
    "${{ inputs.path }}/../package.json",
    "${{ inputs.prefix }}!package.json",
    "${{ inputs.prefix }}:package.json",
    "$UNKNOWN",
    "${{ inputs.unclosed",
    "${{ }}",
    "${{ inputs.outer ${{ inputs.inner }} }}",
  ]) {
    const result = check(source(entry), [bunDecision]);
    expect(result.matched).toEqual([]);
    expect(result.diagnostics).toMatchObject([{ rule: "bun-pins" }]);
  }
  for (const entry of [
    "${{ inputs.sparse }}",
    "${{ format('}}-{0}', inputs.path) }}",
    "${{ inputs.directory }}/package.json",
  ])
    expect(check(source(entry), [bunDecision])).toEqual({
      diagnostics: [],
      matched: [bunDecision],
    });
});

test("all overlapping checkout sparse configurations precede declaration authorization", () => {
  const source = (sparse: string, reverse: boolean, selector: string) => {
    const checkout = `      - uses: ${action("actions/checkout")}\n        with: {path: snapshot}\n`;
    const dynamicCheckout = `      - uses: ${action("actions/checkout")}\n        with:\n          path: snapshot\n          ref: '\${{ inputs.ref }}'\n          sparse-checkout-cone-mode: false\n          sparse-checkout: |\n            ${sparse}\n`;
    return `on: push\njobs:\n  example:\n    steps:\n${reverse ? dynamicCheckout + checkout : checkout + dynamicCheckout}      - id: setup\n        uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: '${selector}'}\n`;
  };
  for (const sparse of ["src", "!package.json", "*${{ inputs.suffix }}"])
    for (const reverse of [false, true])
      for (const selector of [
        "snapshot/package.json",
        "${{ inputs.manifest }}",
      ]) {
        const result = check(source(sparse, reverse, selector), [bunDecision]);
        expect(result.matched).toEqual([]);
        expect(result.diagnostics).toMatchObject([{ rule: "bun-pins" }]);
      }
  for (const reverse of [false, true])
    expect(
      check(source("/package.json", reverse, "snapshot/package.json"), [
        bunDecision,
      ]),
    ).toEqual({ diagnostics: [], matched: [bunDecision] });
});

test("mixed sparse states retain literal manifest requirements", () => {
  for (const entries of [
    ["src", "${{ inputs.sparse }}"],
    ["${{ inputs.sparse }}", "src"],
    ["src${{ inputs.suffix }}", "src"],
  ]) {
    const source = (paths: string[], ref: string) =>
      `on: push\njobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n        with:\n          path: snapshot\n          ref: '${ref}'\n          sparse-checkout-cone-mode: false\n          sparse-checkout: |\n${paths.map((entry) => `            ${entry}\n`).join("")}      - id: setup\n        uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: snapshot/package.json}\n`;
    for (const ref of ["${{ inputs.ref }}", "${{ github.sha }}"]) {
      const omitted = check(source(entries, ref), [bunDecision]);
      expect(omitted.matched).toEqual([]);
      expect(omitted.diagnostics).toMatchObject([{ rule: "bun-pins" }]);
      const present = source([...entries, "package.json"], ref);
      expect(check(present, [bunDecision])).toEqual({
        diagnostics: [],
        matched: [bunDecision],
      });
      expect(check(present).diagnostics).toMatchObject([{ rule: "bun-pins" }]);
      if (ref !== "${{ github.sha }}") continue;
      expect(
        checkRuntimeFile({
          file,
          text: present,
          policy,
          trackedFiles: new Set(["package.json"]),
          readFile: () => JSON.stringify({ packageManager: "bun@0.1.0" }),
          dynamicSelectors: parseDynamicSelectors([bunDecision]),
        }),
      ).toMatchObject([{ rule: "bun-pins" }]);
    }
  }
});

test("reusable workflows do not assign caller SHAs to literal repository defaults", () => {
  for (const repository of ["example/project", "Example/Project"]) {
    const reports: unknown[] = [];
    const matched: unknown[] = [];
    const diagnostics = checkRuntimeFile({
      file,
      text: `on: workflow_call\njobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n        with: {repository: '${repository}'}\n      - id: setup\n        uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: package.json}\n      - uses: ./.github/actions/example\n`,
      policy,
      repository: "example/project",
      trackedFiles: new Set(["package.json"]),
      readFile: () => {
        throw new Error(
          "Literal default branches must not read the inspected manifest",
        );
      },
      onDelegated: (report) => reports.push(report),
      dynamicSelectors: parseDynamicSelectors([bunDecision]),
      onDynamicSelector: (entry) => matched.push(entry),
    });
    expect(diagnostics).toMatchObject([
      { rule: "bun-pins" },
      { rule: "action-pins" },
    ]);
    expect(reports).toEqual([]);
    expect(matched).toEqual([]);
  }
});

test("dynamic sparse acknowledgement retains inspected manifest validation", () => {
  for (const ref of [undefined, "${{ github.sha }}"]) {
    const source = `on: push\njobs:\n  example:\n    steps:\n      - uses: ${action("actions/checkout")}\n        with:\n${ref === undefined ? "" : `          ref: '${ref}'\n`}          sparse-checkout: '\${{ inputs.sparse }}'\n      - id: setup\n        uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: package.json}\n`;
    for (const manifest of [
      JSON.stringify({ packageManager: "bun@0.1.0" }),
      JSON.stringify({}),
      "invalid JSON",
      undefined,
    ]) {
      const reads: string[] = [];
      const diagnostics = checkRuntimeFile({
        file,
        text: source,
        policy,
        trackedFiles: new Set(["package.json"]),
        readFile: (target) => {
          reads.push(target);
          return manifest;
        },
        dynamicSelectors: parseDynamicSelectors([bunDecision]),
      });
      expect(reads).toEqual(["package.json"]);
      expect(diagnostics).toMatchObject([{ rule: "bun-pins" }]);
    }
    expect(check(source, [bunDecision]).diagnostics).toEqual([]);
  }
});

test("deepest checkout owns sparse validation independently of ancestor checkouts", () => {
  type NestedCheckoutOptions = {
    rootSparse: string | undefined;
    nestedSparse: string | undefined;
    reverse: boolean;
    selector: string;
  };
  const source = ({
    rootSparse,
    nestedSparse,
    reverse,
    selector,
  }: NestedCheckoutOptions) => {
    const checkout = (destination: string, sparse: string | undefined) =>
      `      - uses: ${action("actions/checkout")}\n        with:\n          path: ${destination}\n${sparse === undefined ? "" : `          sparse-checkout: '${sparse}'\n`}`;
    const root =
      checkout(".", rootSparse) + (reverse ? "          clean: false\n" : "");
    const nested = checkout("snapshot", nestedSparse);
    return `on: push\njobs:\n  example:\n    steps:\n${reverse ? nested + root : root + nested}      - id: setup\n        uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: '${selector}'}\n`;
  };
  for (const reverse of [false, true]) {
    const nestedAction =
      source({
        rootSparse: "src",
        nestedSparse: undefined,
        reverse,
        selector: "snapshot/package.json",
      }) + "      - uses: ./snapshot/.github/actions/example\n";
    expect(check(nestedAction).diagnostics).toEqual([]);
    const delegatedAction = nestedAction.replace(
      "          path: snapshot\n",
      "          path: snapshot\n          ref: '${{ inputs.ref }}'\n",
    );
    expect(check(delegatedAction).diagnostics).toMatchObject([
      { rule: "action-pins" },
    ]);
    for (const sparse of ["package.json", "src", "!package.json"]) {
      expect(
        check(
          source({
            rootSparse: sparse,
            nestedSparse: undefined,
            reverse,
            selector: "snapshot/package.json",
          }),
        ),
      ).toEqual({ diagnostics: [], matched: [] });
      expect(
        check(
          source({
            rootSparse: undefined,
            nestedSparse: sparse,
            reverse,
            selector: "package.json",
          }),
        ),
      ).toEqual({ diagnostics: [], matched: [] });
    }
    for (const sparse of ["src", "!package.json", "*.json"])
      expect(
        check(
          source({
            rootSparse: "package.json",
            nestedSparse: sparse,
            reverse,
            selector: "snapshot/package.json",
          }),
          [bunDecision],
        ),
      ).toMatchObject({ diagnostics: [{ rule: "bun-pins" }], matched: [] });
  }
});

test("ancestor checkout cleaning invalidates earlier descendant provenance in order", () => {
  for (const destination of ["snapshot", "snapshot/deep"]) {
    const nested = `      - uses: ${action("actions/checkout")}\n        with: {path: ${destination}}\n`;
    const setup = `      - id: setup\n        uses: ${action("oven-sh/setup-bun")}\n        with: {bun-version-file: ${destination}/package.json}\n      - uses: ./${destination}/.github/actions/example\n`;
    const root = (clean: string | undefined) =>
      `      - uses: ${action("actions/checkout")}\n${clean === undefined ? "" : `        with: {clean: ${clean}}\n`}`;
    const source = (steps: string) =>
      `on: push\njobs:\n  example:\n    steps:\n${steps}${setup}`;
    for (const clean of [
      undefined,
      "true",
      "'true'",
      "'${{ inputs.clean }}'",
      "'${{ false }}'",
    ]) {
      const result = check(source(nested + root(clean)), [bunDecision]);
      expect(result.matched).toEqual([]);
      expect(result.diagnostics).toMatchObject([
        { rule: "bun-pins" },
        { rule: "action-pins" },
      ]);
    }
    expect(check(source(root(undefined) + nested)).diagnostics).toEqual([]);
    for (const clean of ["false", "'false'", "' FALSE '"])
      expect(check(source(nested + root(clean))).diagnostics).toEqual([]);
  }
});

test("runtime family and digest rules retain scoped selector decisions", () => {
  const source = (image: string) =>
    `jobs:\n  example:\n    container: '${image}'\n`;
  const digest = `sha256:${"a".repeat(64)}`;
  const valid = check(source(`oven/bun:${policy.bun}@${digest}`), [
    imageDecision,
  ]);
  expect(valid).toEqual({ diagnostics: [], matched: [] });
  const literal = check(source(`oven/bun:0.1.0@${digest}`), [imageDecision]);
  expect(literal.diagnostics).toMatchObject([{ rule: "bun-pins" }]);
  expect(literal.matched).toEqual([]);
  expect(check(source("oven/bun:${{ inputs.tag }}"), [imageDecision])).toEqual({
    diagnostics: [],
    matched: [imageDecision],
  });
  expect(check(source("example/custom:${{ inputs.tag }}"))).toEqual({
    diagnostics: [],
    matched: [],
  });
});

test("Docker FROM uses the shared runtime family classification before scoped declarations", () => {
  const declaration = parseDynamicSelectors([
    {
      path: "Dockerfile",
      line: 1,
      kind: "image",
      reason: "Build supplies the selected runtime image",
    },
  ]);
  const docker = (image: string) => {
    const matched: unknown[] = [];
    const diagnostics = checkRuntimeFile({
      file: "Dockerfile",
      text: `FROM ${image}`,
      policy,
      trackedFiles: new Set(),
      readFile: () => undefined,
      dynamicSelectors: declaration,
      onDynamicSelector: (entry) => matched.push(entry),
    });
    return { diagnostics, matched };
  };
  expect(docker("rust:${RUST_VERSION}-bookworm")).toEqual({
    diagnostics: [],
    matched: [],
  });
  expect(docker("oven/bun:${BUN_VERSION}")).toEqual({
    diagnostics: [],
    matched: declaration,
  });
  expect(docker(`oven/bun:0.1.0@sha256:${"a".repeat(64)}`)).toMatchObject({
    diagnostics: [{ rule: "bun-pins" }],
    matched: [],
  });
});
