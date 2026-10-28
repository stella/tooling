import { expect, test } from "bun:test";
import { stringify } from "yaml";

import {
  type CheckoutSource,
  parseCheckoutSources,
  proveCheckoutSource,
} from "./toolchain-checkout-sources";
import { checkRuntimeFile } from "./toolchain-runtime";

const sha = "a".repeat(40);
const declaration = {
  path: ".github/workflows/release.yml",
  job: "build",
  checkout: "source",
  consumer: "build",
  destination: ".",
  ref: "${{ needs.resolve.outputs.sha }}",
  condition: null,
  selector: ".github/actions/build",
  reason: "Build the resolved release snapshot, not the workflow revision.",
} satisfies CheckoutSource;
const checkout = {
  id: "source",
  uses: `actions/checkout@${sha}`,
  with: { ref: declaration.ref, "persist-credentials": false },
};
const consumer = { id: "build", uses: "./.github/actions/build" };
const workflow = (steps: unknown[]) => ({ jobs: { build: { steps } } });
const prove = (steps: unknown[], entry: CheckoutSource = declaration) =>
  proveCheckoutSource({
    declaration: entry,
    workflow: workflow(steps),
    checkoutSha: sha,
    selector: declaration.selector,
  });

test("exact reviewed selection permits historical source and sequential replacement", () => {
  expect(prove([checkout, consumer])).toBe(true);
  const implicit = { ...declaration, ref: null };
  expect(parseCheckoutSources([implicit])).toEqual([implicit]);
  expect(
    prove(
      [{ ...checkout, with: { "persist-credentials": false } }, consumer],
      implicit,
    ),
  ).toBe(true);
  expect(prove([checkout, consumer], implicit)).toBe(false);
  expect(
    prove([{ id: "source", uses: checkout.uses }, consumer], implicit),
  ).toBe(true);
  for (const options of [null, "invalid", []])
    expect(
      prove(
        [{ id: "source", uses: checkout.uses, with: options }, consumer],
        implicit,
      ),
    ).toBe(false);
  expect(
    prove([
      { ...checkout, id: "old", with: { ref: "main" } },
      checkout,
      consumer,
    ]),
  ).toBe(true);
  expect(prove([checkout, consumer, { ...checkout, id: "later" }])).toBe(true);
  const condition = "steps.resolve.outputs.build == 'true'";
  expect(
    prove(
      [
        { id: "resolve", run: "echo build=true >> $GITHUB_OUTPUT" },
        { ...checkout, if: condition },
        { ...consumer, if: condition },
      ],
      { ...declaration, condition },
    ),
  ).toBe(true);
});

test("consumers cannot override the selected checkout success requirement", () => {
  for (const condition of [
    "always()",
    "failure()",
    "cancelled()",
    "${{ !cancelled() }}",
  ])
    expect(
      prove([
        { ...checkout, id: "old", with: { ref: "main" } },
        { run: "exit 1" },
        checkout,
        { ...consumer, if: condition },
      ]),
    ).toBe(false);
  expect(
    prove([checkout, { ...consumer, if: "github.event_name == 'push'" }]),
  ).toBe(true);
});

test("conditional checkout proofs require immutable operands available before checkout", () => {
  const condition = "steps.resolve.outputs.build == 'true'";
  const declared = { ...declaration, condition };
  const selected = { ...checkout, if: condition };
  const use = { ...consumer, if: condition };
  const producer = { id: "resolve", run: "echo build=true >> $GITHUB_OUTPUT" };
  expect(prove([selected, producer, use], declared)).toBe(false);
  expect(prove([producer, selected, use], declared)).toBe(true);
  expect(prove([producer, selected, producer, use], declared)).toBe(false);
  for (const predicate of [
    "env.BUILD == 'true'",
    "github.action == 'build'",
    "failure()",
    "cancelled()",
    "always()",
    "steps['resolve'].outputs.build == 'true'",
  ])
    expect(
      prove(
        [
          producer,
          { ...checkout, if: predicate },
          { ...consumer, if: predicate },
        ],
        { ...declaration, condition: predicate },
      ),
    ).toBe(false);
  for (const predicate of [
    "inputs.build == true",
    "needs.resolve.outputs.build == 'true'",
    "github.event_name == 'workflow_dispatch'",
    "github.event.inputs.build == 'true'",
    "matrix.build == true",
  ])
    expect(
      prove(
        [
          { ...checkout, if: predicate },
          { ...consumer, if: predicate },
        ],
        { ...declaration, condition: predicate },
      ),
    ).toBe(true);
});

test("every changed source field fails closed", () => {
  for (const changed of [
    { ...checkout, id: "other" },
    { ...checkout, uses: `actions/checkout@${"b".repeat(40)}` },
    { ...checkout, if: "always()" },
    { ...checkout, "continue-on-error": false },
    { ...checkout, with: { ...checkout.with, ref: "main" } },
    { ...checkout, with: { ...checkout.with, path: "other" } },
    { ...checkout, with: { ...checkout.with, repository: "other/repo" } },
    { ...checkout, with: { ...checkout.with, clean: false } },
    { ...checkout, with: { ...checkout.with, CLEAN: false } },
    {
      ...checkout,
      with: { ...checkout.with, "sparse-checkout": "package.json" },
    },
    {
      ...checkout,
      with: { ...checkout.with, "sparse-checkout": ".github/**" },
    },
  ])
    expect(prove([changed, consumer])).toBe(false);
  expect(prove([consumer, checkout])).toBe(false);
  expect(prove([checkout, checkout, consumer])).toBe(false);
  expect(prove([checkout, consumer, consumer])).toBe(false);
  expect(
    prove([{ ...checkout, if: "success()" }, consumer], {
      ...declaration,
      condition: "success()",
    }),
  ).toBe(false);
});

test("intervening overlapping or unknown writers cannot be waived", () => {
  for (const action of [
    "actions/checkout",
    "Actions/Checkout",
    "ACTIONS/CHECKOUT",
  ])
    expect(
      prove([
        checkout,
        { ...checkout, id: "other", uses: `${action}@${sha}` },
        consumer,
      ]),
    ).toBe(false);
  for (const destination of [
    ".",
    "./",
    ".github",
    ".github/",
    "./.github//",
    ".github/actions/build",
    ".github/actions/build/nested",
    "${{ inputs.path }}",
  ])
    expect(
      prove([
        checkout,
        {
          ...checkout,
          id: "other",
          with: { ...checkout.with, path: destination },
        },
        consumer,
      ]),
    ).toBe(false);
  expect(
    prove([
      checkout,
      {
        ...checkout,
        id: "other",
        with: { ...checkout.with, path: "unrelated" },
      },
      consumer,
    ]),
  ).toBe(true);
});

test("sparse coverage rejects every nonliteral pattern even with a matching parent", () => {
  for (const pattern of [
    "!.github/actions/build",
    ".github/**",
    ".github/[ab]",
    "${{ inputs.paths }}",
    "../.github",
    "\\.github",
  ])
    expect(
      prove([
        {
          ...checkout,
          with: {
            ...checkout.with,
            "sparse-checkout-cone-mode": false,
            "sparse-checkout": `.github\n${pattern}`,
          },
        },
        consumer,
      ]),
    ).toBe(false);
  expect(
    prove([
      {
        ...checkout,
        uses: `Actions/Checkout@${sha}`,
        with: {
          ...checkout.with,
          "sparse-checkout-cone-mode": false,
          "sparse-checkout": ".github/actions",
        },
      },
      consumer,
    ]),
  ).toBe(true);
});

test("malformed and duplicate declarations cannot suppress diagnostics", () => {
  for (const field of [
    "path",
    "job",
    "checkout",
    "consumer",
    "destination",
    "ref",
    "selector",
    "reason",
  ])
    expect(() =>
      parseCheckoutSources([{ ...declaration, [field]: "" }]),
    ).toThrow();
  expect(() =>
    parseCheckoutSources([{ ...declaration, condition: true }]),
  ).toThrow();
  expect(() => parseCheckoutSources([declaration, declaration])).toThrow();
  expect(() =>
    parseCheckoutSources([{ ...declaration, extra: true }]),
  ).toThrow();
});

test("runtime integration retains undeclared and changed-writer failures", () => {
  const check = (steps: unknown[], declarations = [declaration]) =>
    checkRuntimeFile({
      file: declaration.path,
      text: stringify(workflow(steps)).replaceAll(
        `actions/checkout@${sha}`,
        `actions/checkout@${sha} # v7`,
      ),
      policy: {
        node: "26.x",
        python: "3.13.7",
        rust: "1.99.1",
        bun: "1.4.4",
        packages: {},
        actions: { "actions/checkout": { sha, version: "v7" } },
      },
      trackedFiles: new Set([declaration.selector]),
      readFile: () => undefined,
      checkoutSources: declarations,
    });
  expect(check([checkout, consumer])).toEqual([]);
  expect(
    check([checkout, consumer], []).some(
      (diagnostic) => diagnostic.rule === "action-pins",
    ),
  ).toBe(true);
  expect(
    check([checkout, { ...checkout, id: "other" }, consumer]).some(
      (diagnostic) => diagnostic.rule === "action-pins",
    ),
  ).toBe(true);
});
