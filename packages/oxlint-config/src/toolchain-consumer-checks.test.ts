import { expect, test } from "bun:test";

import {
  checkConsumerChecks,
  consumerCheckWorkflow,
  parseConsumerChecks,
} from "./toolchain-consumer-checks";

const workflow = ".github/workflows/consumer.yml";
const sha = "1234567890abcdef1234567890abcdef12345678";
const declaration = {
  workflow,
  job: "consumer",
  packages: ["packages/library"],
};
const policy = { consumerNode: "22.21.1", actions: {} };
const job = {
  uses: `${consumerCheckWorkflow}@${sha}`,
  with: {
    packages: JSON.stringify(declaration.packages),
    "consumer-node": policy.consumerNode,
  },
};
const manifest = JSON.stringify({
  name: "@example/library",
  engines: { node: ">=20.10.0" },
});
const files = {
  [workflow]: JSON.stringify({ jobs: { consumer: job } }),
  "packages/library/package.json": manifest,
};
const check = (inputs: Record<string, string> = files) =>
  checkConsumerChecks({ declarations: [declaration], files: inputs, policy });

test("consumer declarations are closed, canonical and unique", () => {
  expect(parseConsumerChecks(undefined)).toEqual([]);
  expect(parseConsumerChecks([declaration])).toEqual([declaration]);
  for (const mutation of [
    { ...declaration, extra: true },
    { ...declaration, workflow: "tools/consumer.yml" },
    { ...declaration, job: "${{ inputs.job }}" },
    { ...declaration, packages: [] },
    { ...declaration, packages: ["packages/library", "packages/library"] },
    ...[
      "../outside",
      "/outside",
      "C:/outside",
      "packages\\library",
      "packages/./library",
      "packages/library/",
      "${{ inputs.package }}",
    ].map((directory) => ({ ...declaration, packages: [directory] })),
  ])
    expect(() => parseConsumerChecks([mutation])).toThrow();
  expect(() => parseConsumerChecks([declaration, declaration])).toThrow();
  expect(() => parseConsumerChecks({})).toThrow();
});

test("only a declared immutable reusable invocation validates published consumer support", () => {
  expect(check()).toEqual([]);
  for (const mutation of [
    { ...job, uses: `${consumerCheckWorkflow}@main` },
    { ...job, uses: `${consumerCheckWorkflow}@${sha}@extra` },
    {
      ...job,
      uses: `other/repo/.github/workflows/package-consumer-compat.yml@${sha}`,
    },
    { ...job, steps: [] },
    { ...job, "runs-on": "ubuntu-latest" },
    { ...job, with: { ...job.with, "consumer-node": "26.0.0" } },
    { ...job, with: { ...job.with, "consumer-node": "${{ inputs.node }}" } },
    { ...job, with: { ...job.with, "Consumer-Node": policy.consumerNode } },
    {
      ...job,
      with: {
        packages: job.with.packages,
        "Consumer-Node": policy.consumerNode,
      },
    },
    { ...job, with: { ...job.with, packages: '["other"]' } },
    { ...job, with: { ...job.with, packages: '["../outside"]' } },
    { ...job, with: { ...job.with, packages: declaration.packages } },
  ])
    expect(
      check({
        ...files,
        [workflow]: JSON.stringify({ jobs: { consumer: mutation } }),
      }),
    ).not.toEqual([]);
  expect(
    checkConsumerChecks({ declarations: [], files, policy }),
  ).toMatchObject([{ rule: "configuration" }]);
  expect(
    checkConsumerChecks({
      declarations: [declaration],
      files,
      policy: {
        ...policy,
        actions: {
          [consumerCheckWorkflow]: { sha: "0".repeat(40), version: "v1" },
        },
      },
    }),
  ).not.toEqual([]);
  expect(check({ "packages/library/package.json": manifest })).not.toEqual([]);
});

test("every declared package must be a tracked published manifest supporting consumer Node", () => {
  for (const value of [
    { name: "@example/library", private: true, engines: { node: ">=20" } },
    { engines: { node: ">=20" } },
    { name: "@example/library" },
    { name: "@example/library", engines: { node: ">=24" } },
    { name: "@example/library", engines: { node: "latest" } },
  ])
    expect(
      check({
        ...files,
        "packages/library/package.json": JSON.stringify(value),
      }),
    ).not.toEqual([]);
  expect(check({ [workflow]: files[workflow] })).not.toEqual([]);
  const root = { ...declaration, packages: ["."] };
  expect(
    checkConsumerChecks({
      declarations: [root],
      files: {
        [workflow]: JSON.stringify({
          jobs: {
            consumer: { ...job, with: { ...job.with, packages: '["."]' } },
          },
        }),
        "package.json": manifest,
      },
      policy,
    }),
  ).toEqual([]);
});

test("semantic aliases and merges cannot conceal consumer input conflicts", () => {
  const text = `template: &job\n  uses: ${job.uses}\n  with: &inputs\n    packages: '${job.with.packages}'\n    consumer-node: ${policy.consumerNode}\njobs:\n  consumer:\n    <<: *job\n`;
  expect(check({ ...files, [workflow]: text })).toEqual([]);
  expect(
    check({
      ...files,
      [workflow]: `${text}    with:\n      <<: *inputs\n      Consumer-Node: ${policy.consumerNode}\n`,
    }),
  ).not.toEqual([]);
  expect(
    check({
      ...files,
      [workflow]: `${text}    uses: ${job.uses}\n    uses: ${job.uses}\n`,
    }),
  ).not.toEqual([]);
});
