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
const aggregate = jobs["checks"];
if (!record(aggregate) || !Array.isArray(aggregate["steps"]))
  throw new Error("Missing aggregate check");
// Release intent runs only on PRs and has its own required status.
const validationJobs = Object.keys(jobs).filter(
  (job) => job !== "checks" && job !== "changeset",
);
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
const variables = Object.entries(env).map(([name, expression]) => {
  const job =
    typeof expression === "string"
      ? /^\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}$/u.exec(expression)?.at(1)
      : undefined;
  if (job === undefined) throw new Error(`Unresolved verdict input ${name}`);
  return { name, job };
});

test("the aggregate awaits every validation job and rejects each failed or skipped dependency", () => {
  expect(new Set(needs)).toEqual(new Set(validationJobs));
  expect(new Set(variables.map(({ job }) => job))).toEqual(
    new Set(validationJobs),
  );
  const evaluate = (changedJob?: string, result = "success") =>
    Bun.spawnSync(["/bin/bash", "-eu", "-c", run], {
      env: Object.fromEntries(
        variables.map(({ name, job }) => [
          name,
          job === changedJob ? result : "success",
        ]),
      ),
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode;
  expect(evaluate()).toBe(0);
  for (const job of validationJobs)
    for (const result of ["failure", "cancelled", "skipped"])
      expect(evaluate(job, result), `${job}: ${result}`).not.toBe(0);
});
