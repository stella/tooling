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
const policy = {
  consumerNode: "22.21.1",
  actions: { [consumerCheckWorkflow]: { sha, version: "v1" } },
};
const triggers = { schedule: [{ cron: "13 2 * * *" }], workflow_dispatch: {} };
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
  "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
  [workflow]: JSON.stringify({ on: triggers, jobs: { consumer: job } }),
  "packages/library/package.json": manifest,
};
const check = (inputs: Record<string, string> = files) =>
  checkConsumerChecks({ declarations: [declaration], files: inputs, policy });

test("consumer declarations select only the runner's discovered workspace members", () => {
  for (const workspaces of [
    [],
    ["apps/*"],
    ["packages/*", "!packages/library"],
  ]) {
    expect(
      check({
        ...files,
        "package.json": JSON.stringify({ private: true, workspaces }),
      }),
    ).toMatchObject([
      {
        rule: "configuration",
        message:
          "consumerChecks package must be a discovered workspace member: packages/library/package.json",
      },
    ]);
  }
  const nested = "packages/owner/libraries/nested";
  expect(
    checkConsumerChecks({
      declarations: [{ ...declaration, packages: [nested] }],
      files: {
        "package.json": files["package.json"],
        "packages/owner/package.json": JSON.stringify({
          private: true,
          workspaces: ["libraries/*"],
        }),
        [`${nested}/package.json`]: manifest,
        [workflow]: JSON.stringify({
          on: triggers,
          jobs: {
            consumer: {
              ...job,
              with: { ...job.with, packages: JSON.stringify([nested]) },
            },
          },
        }),
      },
      policy,
    }),
  ).toEqual([]);
});

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
    ].map((directory) => ({
      workflow: declaration.workflow,
      job: declaration.job,
      packages: [directory],
    })),
  ])
    expect(() => parseConsumerChecks([mutation])).toThrow();
  expect(() => parseConsumerChecks([declaration, declaration])).toThrow();
  expect(() => parseConsumerChecks({})).toThrow();
});

test("only a declared immutable reusable invocation validates published consumer support", () => {
  expect(check()).toEqual([]);
  expect(
    checkConsumerChecks({
      declarations: [declaration],
      files,
      policy: { consumerNode: policy.consumerNode, actions: {} },
    }),
  ).toMatchObject([{ message: expect.stringContaining("approved immutable") }]);
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
        [workflow]: JSON.stringify({
          on: triggers,
          jobs: { consumer: mutation },
        }),
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

test("declared consumer workflows require valid scheduled execution", () => {
  for (const cron of ["13 2 * * *", "0 0 1 JAN MON", "20/15 0-4 * * 1,3,5"])
    expect(
      check({
        ...files,
        [workflow]: JSON.stringify({
          on: { schedule: [{ cron }] },
          jobs: { consumer: job },
        }),
      }),
    ).toEqual([]);
  for (const on of [
    undefined,
    { push: {} },
    { workflow_dispatch: {} },
    { schedule: [] },
    { schedule: { cron: "13 2 * * *" } },
    { schedule: [{ cron: 13 }] },
    { schedule: [{ cron: "" }] },
    { schedule: [{ cron: "13 2 * * *" }, { cron: "invalid" }] },
  ])
    expect(
      check({
        ...files,
        [workflow]: JSON.stringify({ on, jobs: { consumer: job } }),
      }),
    ).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("on.schedule"),
      }),
    );
});

test("every declared package must be a tracked published manifest supporting consumer Node", () => {
  for (const value of [
    { name: "@example/library" },
    { name: "@example/library", engines: {} },
    { name: "@example/library", engines: { npm: ">=10" } },
  ])
    expect(
      check({
        ...files,
        "packages/library/package.json": JSON.stringify(value),
      }),
    ).toEqual([]);
  for (const value of [
    { name: "@example/library", private: true, engines: { node: ">=20" } },
    { engines: { node: ">=20" } },
    { name: "@example/library", engines: null },
    { name: "@example/library", engines: { node: null } },
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
          on: triggers,
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
  const text = `on:\n  schedule:\n    - cron: "13 2 * * *"\n  workflow_dispatch: {}\ntemplate: &job\n  uses: ${job.uses}\n  with: &inputs\n    packages: '${job.with.packages}'\n    consumer-node: ${policy.consumerNode}\njobs:\n  consumer:\n    <<: *job\n`;
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

test("scheduled consumer jobs cannot be gated by conditions", () => {
  for (const condition of [
    "github.event_name == 'workflow_dispatch'",
    "${{ github.event_name == 'push' }}",
    false,
    true,
    "always()",
  ]) {
    const diagnostics = check({
      ...files,
      [workflow]: JSON.stringify({
        on: triggers,
        jobs: { consumer: { ...job, if: condition } },
      }),
    });
    expect(
      diagnostics.some(({ message }) =>
        message.includes("unconditional reusable job"),
      ),
    ).toBe(true);
    expect(
      diagnostics.some(({ message }) =>
        message.includes("no matching reusable invocation"),
      ),
    ).toBe(true);
  }
  expect(check()).toEqual([]);
});
