import path from "node:path";
import { satisfies, valid, validRange } from "semver";

export type NodeCompatibility = {
  package: string;
  workflow: string;
  job: string;
  step: string;
  version: string;
  reason: string;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const directory = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "" &&
  !/[\\:$*?\s]/.test(value) &&
  !value.startsWith("/") &&
  !value.split("/").includes("..");
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z_][\w-]*$/.test(value);

export const parseNodeCompatibility = (input: unknown): NodeCompatibility[] => {
  if (input === undefined) return [];
  if (!Array.isArray(input))
    throw new Error("nodeCompatibility must be an array");
  const result: NodeCompatibility[] = [];
  const locations = new Set<string>();
  for (const entry of input) {
    if (
      !record(entry) ||
      Object.keys(entry).some(
        (key) =>
          !["package", "workflow", "job", "step", "version", "reason"].includes(
            key,
          ),
      ) ||
      !directory(entry["package"]) ||
      typeof entry["workflow"] !== "string" ||
      !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry["workflow"]) ||
      !identifier(entry["job"]) ||
      !identifier(entry["step"]) ||
      typeof entry["version"] !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(entry["version"]) ||
      valid(entry["version"]) !== entry["version"] ||
      typeof entry["reason"] !== "string" ||
      entry["reason"].trim() === ""
    )
      throw new Error(
        "Node compatibility requires a package directory, workflow/job/step, exact stable version and reason",
      );
    const location = `${entry["workflow"]}:${entry["job"]}:${entry["step"]}`;
    if (locations.has(location))
      throw new Error("Node compatibility locations must be unique");
    locations.add(location);
    result.push({
      package: entry["package"],
      workflow: entry["workflow"],
      job: entry["job"],
      step: entry["step"],
      version: entry["version"],
      reason: entry["reason"],
    });
  }
  return result;
};

/** Compatibility targets remain inside the actual published package contract. */
export const nodeCompatibilityProblem = (
  entry: NodeCompatibility,
  files: Record<string, string>,
) => {
  const text = files[path.posix.join(entry.package, "package.json")];
  if (text === undefined || files[entry.workflow] === undefined)
    return "Node compatibility package and workflow must be tracked";
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return "Node compatibility package manifest must be valid JSON";
  }
  if (
    !record(manifest) ||
    manifest["private"] === true ||
    typeof manifest["name"] !== "string" ||
    manifest["name"].trim() === "" ||
    !record(manifest["engines"]) ||
    typeof manifest["engines"]["node"] !== "string" ||
    validRange(manifest["engines"]["node"]) === null
  )
    return "Node compatibility requires a published package with a valid engines.node contract";
  if (!satisfies(entry.version, manifest["engines"]["node"]))
    return `Node compatibility ${entry.version} is outside ${entry.package} engines.node`;
  return undefined;
};
