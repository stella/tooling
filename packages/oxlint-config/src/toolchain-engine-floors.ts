import path from "node:path";
import { minVersion, satisfies, valid, validRange } from "semver";
import { parseDocument } from "yaml";

export type EngineFloor = { package: string; workflow: string; job: string };
export type ResolvedEngineFloor = EngineFloor & {
  range: string;
  major: number;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const repositoryPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "" &&
  !/^[A-Za-z]:/.test(value) &&
  !/[\\\s]/.test(value) &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
  value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");

export const parseEngineFloors = (input: unknown): EngineFloor[] => {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("engineFloors must be an array");
  const result: EngineFloor[] = [];
  const jobs = new Set<string>();
  for (const entry of input) {
    if (
      !record(entry) ||
      Object.keys(entry).some(
        (key) => !["package", "workflow", "job"].includes(key),
      ) ||
      (entry["package"] !== "." && !repositoryPath(entry["package"])) ||
      !repositoryPath(entry["workflow"]) ||
      !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry["workflow"]) ||
      typeof entry["job"] !== "string" ||
      entry["job"].trim() === ""
    )
      throw new Error(
        "each engine floor requires a repository package directory, workflow path and job",
      );
    const key = `${entry["workflow"]}:${entry["job"]}`;
    if (jobs.has(key))
      throw new Error("engine floor workflow jobs must be unique");
    jobs.add(key);
    result.push({
      package: entry["package"],
      workflow: entry["workflow"],
      job: entry["job"],
    });
  }
  return result;
};

export const resolveEngineFloor = (
  entry: EngineFloor,
  files: Record<string, string>,
): ResolvedEngineFloor => {
  const manifestText = files[path.posix.join(entry.package, "package.json")];
  const workflowText = files[entry.workflow];
  if (manifestText === undefined || workflowText === undefined)
    throw new Error("engine floor package and workflow must be tracked");
  const manifest: unknown = JSON.parse(manifestText);
  if (
    !record(manifest) ||
    manifest["private"] === true ||
    typeof manifest["name"] !== "string" ||
    manifest["name"].trim() === "" ||
    !record(manifest["engines"]) ||
    typeof manifest["engines"]["node"] !== "string"
  )
    throw new Error(
      "engine floor package must be published and declare engines.node",
    );
  const range = manifest["engines"]["node"];
  const minimum = validRange(range) === null ? null : minVersion(range);
  if (minimum === null || minimum.prerelease.length !== 0)
    throw new Error("engine floor engines.node must declare a stable minimum");
  const document = parseDocument(workflowText, { merge: true });
  if (document.errors.length !== 0)
    throw new Error("engine floor workflow must be valid YAML");
  const workflow: unknown = document.toJS({ maxAliasCount: 100 });
  if (!record(workflow) || !record(workflow["jobs"]))
    throw new Error("engine floor job must exist in its tracked workflow");
  const job = workflow["jobs"][entry.job];
  if (!record(job))
    throw new Error("engine floor job must exist in its tracked workflow");
  if (!Array.isArray(job["steps"]) || Object.hasOwn(job, "uses"))
    throw new Error(
      "engine floor job must declare steps and cannot reuse a workflow",
    );
  return { ...entry, range, major: minimum.major };
};

export const engineFloorSelectorMatches = (
  value: unknown,
  floor: ResolvedEngineFloor,
) => {
  if (
    typeof value !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(value) ||
    valid(value) !== value
  )
    return false;
  return (
    Number(value.split(".").at(0)) === floor.major &&
    satisfies(value, floor.range)
  );
};
