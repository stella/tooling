/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";

import { checkWorkflowTrust } from "./toolchain-workflow-trust";

const trusted = "needs.trust-check.outputs.trusted == 'true'";
const canonical = `always() && !cancelled() && (github.event_name != 'pull_request' || ${trusted})`;

const check = (source: string) => {
  const document = parseDocument(source);
  expect(document.errors).toEqual([]);
  return checkWorkflowTrust(document.toJS());
};

type JobFixtureOptions = {
  command?: string;
  events?: string;
  needs?: string;
  jobIf?: string | boolean;
  stepIf?: string | boolean;
};

const workflow = ({
  command = "bunx --no-install stll-toolchain-changed --since origin/main",
  events = "[pull_request, push]",
  needs,
  jobIf,
  stepIf,
}: JobFixtureOptions = {}) => `on: ${events}
jobs:
  trust-check:
    runs-on: ubuntu-latest
    steps:
      - run: echo trust-decision
  metadata:
    runs-on: ubuntu-latest
    steps: [{run: echo metadata-only}]
  build:
    runs-on: ubuntu-latest
    steps: [{run: echo metadata-only}]
  trust-check-other:
    runs-on: ubuntu-latest
    steps: [{run: echo metadata-only}]
  inspect:
    runs-on: ubuntu-latest
${needs === undefined ? "" : `    needs: ${needs}\n`}${jobIf === undefined ? "" : `    if: ${JSON.stringify(jobIf)}\n`}    steps:
      - run: echo metadata-only
      - run: ${JSON.stringify(command)}
${stepIf === undefined ? "" : `        if: ${JSON.stringify(stepIf)}\n`}`;

const expectUnsafe = (source: string, job = "inspect", step = 1) => {
  const findings = check(source);
  expect(findings, source).toHaveLength(1);
  expect(findings.at(0)).toMatchObject({ type: "step", job, step });
  expect(findings.at(0)?.message.length).toBeGreaterThan(0);
};

const managerCommands = [
  "npm run lint",
  "npm test",
  "npm exec -- oxlint .",
  "npm install",
  "npm ci",
  "npm add fast-check",
  "npm run lint --ignore-scripts",
  "npm test --ignore-scripts",
  "npm --ignore-scripts test",
  "npm install --ignore-scripts=false",
  "npm ci --ignore-scripts --ignore-scripts=false",
  ...["pnpm", "yarn"].flatMap((manager) => [
    `${manager} test`,
    `${manager} run lint`,
    `${manager} exec oxlint .`,
    `${manager} dlx shared-check`,
    `${manager} add fast-check`,
    `${manager} install`,
    `${manager} ci`,
    `${manager} --version`,
    `${manager} --help`,
    `${manager} install --ignore-scripts`,
    `${manager} ci --ignore-scripts`,
  ]),
  ...["npm", "pnpm", "yarn"].flatMap((manager) => [
    `env CI=true ${manager} run lint`,
    `command ${manager} run lint`,
    `bash -c '${manager} run lint'`,
  ]),
];

const commands = [
  ...managerCommands,
  "bunx --no-install stll-toolchain-changed --since origin/main",
  "npx --no-install shared-check",
  "./node_modules/.bin/oxlint .",
  "node_modules/.bin/oxlint .",
  '"/workspace/node_modules/.bin/oxlint" .',
  '"bunx" --no-install shared-check',
  "'npx' --no-install shared-check",
  "env CI=true bunx --no-install shared-check",
  "env -i PATH=/usr/local/bin npx --no-install shared-check",
  "/usr/bin/env bunx --no-install shared-check",
  "CI=true bunx --no-install shared-check",
  "command bunx --no-install shared-check",
  "exec npx --no-install shared-check",
  "command -p bunx --no-install shared-check",
  "command -p -- bunx --no-install shared-check",
  "exec -a ci-check npx --no-install shared-check",
  "exec -cl npx --no-install shared-check",
  "env CI=true command -p bunx --no-install shared-check",
  "node scripts/check.mjs",
  "bash scripts/check.sh",
  "sh ./scripts/check.sh",
  "python3 scripts/check.py",
  '"node" "scripts/check.js"',
  "bash -c 'bunx --no-install shared-check'",
  'sh -lc "npx --no-install shared-check"',
  "result=$(bunx --no-install shared-check)",
  "result=`npx --no-install shared-check`",
  'printf "%s" "$(bunx --no-install shared-check)"',
  "true && bunx --no-install shared-check",
  "printf input | npx --no-install shared-check",
  "echo starting\nbunx --no-install shared-check",
  "bun run check:toolchain",
  "bun run --cwd packages/core typecheck",
  "bun --cwd packages/core run typecheck",
  "bun oxlint .",
  "bun install --frozen-lockfile",
  "bun --cwd packages/core install --frozen-lockfile",
  "bun install --ignore-scripts=false",
  "bun install --ignore-scripts --ignore-scripts=false",
  "bun install --ignore-scripts=false --ignore-scripts",
  "bun install --ignore-scripts && bunx --no-install shared-check",
];

test.each(commands)(
  "repository invocation %s requires the declared trust gate",
  (command) => {
    expectUnsafe(workflow({ command }));
    expect(
      check(workflow({ command, needs: "trust-check", jobIf: canonical })),
    ).toEqual([]);
  },
);

test("quoted documentation and script-free installation do not execute dependencies", () => {
  for (const command of [
    'echo "bunx --no-install shared-check"',
    "echo npx shared-check",
    "printf '%s\\n' './node_modules/.bin/oxlint .; bun run check:toolchain'",
    "RUN_COMMAND='bunx --no-install shared-check'",
    "# bunx --no-install shared-check\necho metadata-only",
    "bun --version",
    "node --version",
    "npm --version",
    "npm install --ignore-scripts",
    "npm ci --ignore-scripts",
    "env CI=true npm ci --ignore-scripts",
    "command npm install --ignore-scripts",
    "bash -c 'npm ci --ignore-scripts'",
    'echo "npm run lint; pnpm install; yarn test"',
    "git diff --name-only",
    '"${RUNNER_TEMP}/actionlint" -color',
    "command -v bunx",
    "command -V npx",
    "command -pv bunx",
    "command -pV npx",
    'echo "node scripts/check.mjs"',
    "bun install --frozen-lockfile --ignore-scripts",
    'bun install "--ignore-scripts"',
    "bun install --ignore-scripts=true",
    "bun --cwd packages/core install --ignore-scripts",
  ]) {
    expect(check(workflow({ command }))).toEqual([]);
  }
});

test("a direct trust dependency and a restrictive condition are both required", () => {
  for (const options of [
    { needs: "trust-check" },
    { jobIf: trusted },
    { needs: "[build]", jobIf: trusted },
    { needs: "[trust-check-other]", jobIf: trusted },
    { needs: "trust-check", jobIf: "always()" },
    { needs: "trust-check", jobIf: `${trusted} || always()` },
    {
      needs: "trust-check",
      jobIf: `${trusted} || github.event.pull_request.draft == false`,
    },
    { needs: "trust-check", jobIf: "needs.trust-check.outputs.trusted" },
    {
      needs: "trust-check",
      jobIf: "needs.trust-check.outputs.trusted != 'false'",
    },
    { needs: "trust-check", jobIf: "needs.trust-check.result == 'success'" },
    {
      needs: "trust-check",
      jobIf: `needs.trust-check.result == 'skipped' || ${trusted}`,
    },
  ]) {
    expectUnsafe(workflow(options));
  }

  const indirect = workflow({ needs: "build", jobIf: trusted }).replace(
    "  build:\n    runs-on: ubuntu-latest\n",
    "  build:\n    needs: trust-check\n    runs-on: ubuntu-latest\n",
  );
  expectUnsafe(indirect);
});

test("job and step conditions preserve every rejecting branch of the trust decision", () => {
  for (const condition of [
    trusted,
    `\${{ ${trusted} }}`,
    `success() && (${trusted})`,
    canonical,
    `(${trusted}) && (always() || cancelled())`,
    `github.event_name == 'push' || ${trusted}`,
    "github.event_name != 'pull_request'",
  ]) {
    expect(
      check(workflow({ needs: "[metadata, trust-check]", jobIf: condition })),
    ).toEqual([]);
    expect(
      check(workflow({ needs: "trust-check", stepIf: condition })),
    ).toEqual([]);
    expect(
      check(
        workflow({
          needs: "trust-check",
          jobIf: "always()",
          stepIf: condition,
        }),
      ),
    ).toEqual([]);
  }
});

test("each declared PR trigger must be rejected when trust is false or absent", () => {
  const events = "[pull_request, pull_request_target, push]";
  expectUnsafe(workflow({ events, needs: "trust-check", jobIf: canonical }));
  expectUnsafe(
    workflow({
      events,
      needs: "trust-check",
      jobIf: `github.event_name != 'pull_request_target' || ${trusted}`,
    }),
  );
  const both = `(github.event_name != 'pull_request' && github.event_name != 'pull_request_target') || ${trusted}`;
  expect(
    check(workflow({ events, needs: "trust-check", jobIf: both })),
  ).toEqual([]);
  expect(
    check(workflow({ events, needs: "trust-check", stepIf: both })),
  ).toEqual([]);
});

test("string, list and mapping trigger declarations select the same trust policy", () => {
  for (const events of [
    "pull_request",
    "[pull_request]",
    "{pull_request: {types: [opened, synchronize]}}",
    "pull_request_target",
    "[pull_request_target]",
    "{pull_request_target: null}",
  ]) {
    expectUnsafe(workflow({ events }));
  }
  for (const source of [
    workflow({ events: "[push, workflow_dispatch]" }),
    "on: pull_request\njobs:\n  inspect:\n    steps: [{run: bunx shared-check}]\n",
    "on: pull_request\njobs: {}\n",
    "on: push\njobs: {}\n",
  ]) {
    expect(check(source)).toEqual([]);
  }
  for (const input of [null, [], "not a workflow", {}]) {
    expect(checkWorkflowTrust(input)).toEqual([]);
  }
});

test("local actions are dependency execution and external pinned actions are not", () => {
  const source = workflow().replace(
    /      - run: "bunx[^\n]+"\n/u,
    "      - uses: ./.github/actions/setup-workspace\n",
  );
  expectUnsafe(source);
  expect(
    check(
      source.replace(
        "    runs-on: ubuntu-latest\n    steps:\n      - run: echo metadata-only",
        `    needs: trust-check\n    if: ${JSON.stringify(trusted)}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo metadata-only`,
      ),
    ),
  ).toEqual([]);
  expect(
    check(
      source.replace(
        "uses: ./.github/actions/setup-workspace",
        `uses: actions/checkout@${"a".repeat(40)}`,
      ),
    ),
  ).toEqual([]);
});

const stepCoordinates = (findings: ReturnType<typeof checkWorkflowTrust>) =>
  findings.map((finding) => {
    if (finding.type !== "step") throw new Error("expected a step finding");
    return { type: finding.type, job: finding.job, step: finding.step };
  });

test("YAML aliases preserve execution checks and zero-based step locations", () => {
  const steps = check(`on: pull_request
jobs:
  trust-check:
    steps: [{run: echo trust-decision}]
  inspect:
    steps:
      - run: echo metadata-only
      - &execute
        run: bunx --no-install shared-check
      - *execute
`);
  expect(stepCoordinates(steps)).toEqual([
    { type: "step", job: "inspect", step: 1 },
    { type: "step", job: "inspect", step: 2 },
  ]);
  const jobs = check(`on: pull_request
jobs:
  trust-check:
    steps: [{run: echo trust-decision}]
  inspect: &execute
    steps: [{run: bunx --no-install shared-check}]
  inspect-again: *execute
`);
  expect(stepCoordinates(jobs)).toEqual([
    { type: "step", job: "inspect", step: 0 },
    { type: "step", job: "inspect-again", step: 0 },
  ]);
});

test("the trust decision itself must not execute repository dependency code", () => {
  const source = workflow({ command: "echo metadata-only" }).replace(
    "run: echo trust-decision",
    "run: bunx --no-install shared-check",
  );
  expectUnsafe(source, "trust-check", 0);
});

test("the documented workflow example obeys the trust contract", () => {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  for (const file of ["../../../README.md", "../README.md"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const section = source
      .split("Run repository-installed tools only after")
      .at(1);
    expect(section).toBeDefined();
    const yaml = section?.match(/```yaml\n([\s\S]*?)\n```/u)?.at(1);
    expect(yaml).toBeDefined();
    const document = parseDocument(yaml ?? "");
    expect(document.errors).toEqual([]);
    const snippet: unknown = document.toJS();
    if (!isRecord(snippet))
      throw new Error("documented jobs must be a mapping");
    const detector = snippet["check-changes"];
    if (!isRecord(detector))
      throw new Error("documented detector job is missing");
    const sample = {
      on: ["pull_request", "pull_request_target"],
      jobs: {
        "trust-check": {
          "runs-on": "ubuntu-latest",
          steps: [{ run: "echo trust-decision" }],
        },
        ...snippet,
      },
    };
    expect(Object.hasOwn(sample.jobs, "check-changes")).toBe(true);
    expect(checkWorkflowTrust(sample)).toEqual([]);

    const unordered = { ...detector };
    delete unordered["needs"];
    const findings = checkWorkflowTrust({
      ...sample,
      jobs: { ...sample.jobs, "check-changes": unordered },
    });
    expect(findings).toHaveLength(1);
    expect(findings.at(0)).toMatchObject({
      type: "step",
      job: "check-changes",
      step: 0,
    });
  }
});

test("non-PR-only or never-running steps need no PR trust dependency", () => {
  for (const condition of [
    false,
    "false",
    "github.event_name != 'pull_request'",
  ]) {
    expect(check(workflow({ jobIf: condition }))).toEqual([]);
    expect(check(workflow({ stepIf: condition }))).toEqual([]);
  }
  expect(
    check(
      workflow({
        events: "[pull_request, pull_request_target, push]",
        jobIf: "github.event_name != 'pull_request'",
        stepIf: "github.event_name != 'pull_request_target'",
      }),
    ),
  ).toEqual([]);
});

type ReusableFixtureOptions = {
  events?: string;
  needs?: string;
  jobIf?: string;
  uses?: string;
};

const reusableWorkflow = ({
  events = "[pull_request, pull_request_target, push]",
  needs,
  jobIf,
  uses = "./.github/workflows/build.yml",
}: ReusableFixtureOptions = {}) => `on: ${events}
jobs:
  trust-check:
    runs-on: ubuntu-latest
    steps: [{run: echo trust-decision}]
  metadata:
    needs: trust-check
    runs-on: ubuntu-latest
    steps: [{run: echo metadata-only}]
  build:
${needs === undefined ? "" : `    needs: ${needs}\n`}${jobIf === undefined ? "" : `    if: ${JSON.stringify(jobIf)}\n`}    uses: ${uses}
`;

const expectUnsafeJob = (source: string) => {
  const findings = check(source);
  expect(findings, source).toHaveLength(1);
  expect(findings.at(0)).toMatchObject({ type: "job", job: "build" });
  expect(findings.at(0)).not.toHaveProperty("step");
  expect(findings.at(0)?.message.length).toBeGreaterThan(0);
};

test("local reusable workflows require the same direct trust gate as executable steps", () => {
  for (const events of [
    "pull_request",
    "pull_request_target",
    "[pull_request, pull_request_target, push]",
  ]) {
    expectUnsafeJob(reusableWorkflow({ events }));
    expectUnsafeJob(reusableWorkflow({ events, needs: "trust-check" }));
    expectUnsafeJob(reusableWorkflow({ events, jobIf: trusted }));
    expectUnsafeJob(
      reusableWorkflow({ events, needs: "metadata", jobIf: trusted }),
    );
    expectUnsafeJob(
      reusableWorkflow({
        events,
        needs: "trust-check",
        jobIf: `${trusted} || always()`,
      }),
    );
    expect(
      check(
        reusableWorkflow({
          events,
          needs: "[metadata, trust-check]",
          jobIf: trusted,
        }),
      ),
    ).toEqual([]);
    expect(
      check(reusableWorkflow({ events, jobIf: "github.event_name == 'push'" })),
    ).toEqual([]);
  }
  expectUnsafeJob(reusableWorkflow({ needs: "trust-check", jobIf: canonical }));
  expect(
    check(
      reusableWorkflow({
        uses: `stella/.github/.github/workflows/build.yml@${"a".repeat(40)}`,
      }),
    ),
  ).toEqual([]);
});

test("YAML aliases retain job findings without invented step coordinates", () => {
  const findings = check(`on: [pull_request, pull_request_target]
jobs:
  trust-check:
    runs-on: ubuntu-latest
    steps: [{run: echo trust-decision}]
  build: &reusable
    uses: ./.github/workflows/build.yml
  build-again: *reusable
`);
  expect(findings).toHaveLength(2);
  const jobs = findings.map((finding) => {
    if (finding.type !== "job") throw new Error("expected a job finding");
    expect(finding).not.toHaveProperty("step");
    return { type: finding.type, job: finding.job };
  });
  expect(jobs).toEqual([
    { type: "job", job: "build" },
    { type: "job", job: "build-again" },
  ]);
});


test.each(["pnpx shared-check", "yarnpkg test"])(
  "package-manager alias %s follows the declared trust gate",
  (command) => {
    expectUnsafe(workflow({ command }));
    expect(check(workflow({ command, needs: "trust-check", jobIf: canonical })))
      .toEqual([]);
  },
);


test("Actions event comparisons use case-insensitive string equality", () => {
  for (const event of ["pull_request", "pull_request_target"]) {
    for (const literal of [event, event.toUpperCase(), event.replaceAll("request", "ReQuEsT")]) {
      expectUnsafe(workflow({ events: event, jobIf: `github.event_name == '${literal}'` }));
      expectUnsafe(workflow({ events: event, stepIf: `github.event_name == '${literal}'` }));
      expect(check(workflow({ events: event, jobIf: `github.event_name != '${literal}'` })))
        .toEqual([]);
    }
    // Unknown bare names cannot prove an event exclusion.
    expectUnsafe(workflow({ events: event, jobIf: "github.event_name == PULL_REQUEST" }));
  }
  expect(check(workflow({ needs: "trust-check", jobIf: "needs.trust-check.outputs.trusted == 'TRUE'" })))
    .toEqual([]);
  expectUnsafe(workflow({ needs: "trust-check", jobIf: "needs.trust-check.outputs.trusted == 'FALSE'" }));
});


test("unknown package-manager flags and inline execution never establish install-only status", () => {
  for (const command of [
    "bun --eval=process.exit(0)",
    "bun --eval=process.exit(0) install --ignore-scripts",
    "bun --preload=./scripts/start.ts install --ignore-scripts",
    "bun install --ignore-scripts --future-option",
    "npm ci --ignore-scripts --future-option",
    "npm --future-option",
    "bun --cwd --ignore-scripts install",
    "npm ci --ignore-scripts && npm run check",
    "bun install --ignore-scripts && bun run check",
  ]) expectUnsafe(workflow({ command }));
  for (const command of [
    "npm --prefix packages/core ci --ignore-scripts --no-audit",
    "npm --ignore-scripts ci",
    "bun --cwd packages/core install --frozen-lockfile --ignore-scripts",
  ]) expect(check(workflow({ command }))).toEqual([]);
});


test.each(["./scripts/check", "scripts/check", "../shared/check"])(
  "relative executable %s follows the declared trust gate",
  (command) => expectUnsafe(workflow({ command })),
);
