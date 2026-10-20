import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const workflow: unknown = Bun.YAML.parse(
  readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf-8",
  ),
);
if (!record(workflow) || !record(workflow["jobs"]))
  throw new Error("Missing workflow jobs");
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((item: unknown) => typeof item === "string");
const jobs = workflow["jobs"];
const aggregate = jobs["ci-result"];
if (!record(aggregate) || !Array.isArray(aggregate["steps"]))
  throw new Error("Missing aggregate check");
const validationJobs = Object.keys(jobs).filter((job) => job !== "ci-result");
const verdict = aggregate["steps"].find(
  (step: unknown) => record(step) && typeof step["run"] === "string",
);
if (
  !record(verdict) ||
  typeof verdict["run"] !== "string" ||
  !record(verdict["env"])
)
  throw new Error("Missing aggregate verdict");
const needs = aggregate["needs"];
if (!strings(needs)) throw new Error("Missing aggregate dependencies");
const run = verdict["run"];
const env = verdict["env"];
const variables = Object.entries(env)
  .filter(([name]) => name !== "EVENT_NAME")
  .map(([name, expression]) => {
  const job =
    typeof expression === "string"
      ? /^\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}$/u.exec(expression)?.at(1)
      : undefined;
  if (job === undefined) throw new Error(`Unresolved verdict input ${name}`);
  return { name, job };
});

test("the aggregate awaits every validation job and rejects every failed or cancelled dependency", () => {
  expect(aggregate["if"]).toBe("always()");
  expect(env["EVENT_NAME"]).toBe("${{ github.event_name }}");
  expect(new Set(needs)).toEqual(new Set(validationJobs));
  expect(new Set(variables.map(({ job }) => job))).toEqual(
    new Set(validationJobs),
  );
  type GateCase = { changedJob?: string; result?: string; event: string };
  const evaluate = ({ changedJob, result = "success", event }: GateCase) =>
    Bun.spawnSync(["/bin/bash", "-eu", "-c", run], {
      env: {
        EVENT_NAME: event,
        ...Object.fromEntries(
          variables.map(({ name, job }) => {
            if (job === changedJob) return [name, result];
            const defaultResult =
              job === "changeset" && event !== "pull_request" ? "skipped" : "success";
            return [name, defaultResult];
          }),
        ),
      },
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode;
  for (const event of ["pull_request", "merge_group", "push"]) {
    expect(evaluate({ event })).toBe(0);
    for (const job of validationJobs) {
      for (const result of ["failure", "cancelled", "skipped", "unexpected"]) {
        const allowed =
          job === "changeset" && event !== "pull_request" && result === "skipped";
        expect(
          evaluate({ changedJob: job, result, event }) === 0,
          `${event}: ${job}: ${result}`,
        ).toBe(allowed);
      }
    }
  }
}, 15_000);

test("the required-check workflows handle merge groups and use the reviewed verifier", () => {
  if (!record(workflow["on"])) throw new Error("Missing workflow triggers");
  expect(workflow["on"]).toHaveProperty("merge_group");
  const cla: unknown = Bun.YAML.parse(
    readFileSync(new URL("../.github/workflows/cla.yml", import.meta.url), "utf8"),
  );
  if (
    !record(cla) || !record(cla["on"]) || !record(cla["permissions"]) ||
    !record(cla["jobs"]) || !record(cla["jobs"]["cla"])
  ) throw new Error("Missing CLA workflow contract");
  expect(cla["on"]["merge_group"]).toEqual({ types: ["checks_requested"] });
  expect(cla["on"]["pull_request_target"]).toEqual({
    types: ["opened", "synchronize", "reopened", "ready_for_review"],
  });
  expect(cla["jobs"]["cla"]["uses"]).toBe(
    "stella/.github/.github/workflows/cla.yml@caa3ee1c2d02ef807994fdd3907c55ba104aff00",
  );
  expect(cla["jobs"]["cla"]["if"]).toContain("github.event_name == 'merge_group'");
  expect(cla["permissions"]).toEqual({
    contents: "read", issues: "write", "pull-requests": "read", checks: "write",
  });
}, 15_000);
