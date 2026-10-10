import path from "node:path";
import { parseDocument } from "yaml";

import { discoverConsumerPackages } from "./consumer-compat-config";
import { consumerNodeSupportMatches } from "./consumer-node-support";
import { githubAutomationFileKind } from "./toolchain-inputs";

export const consumerCheckWorkflow =
  "stella/.github/.github/workflows/package-consumer-compat.yml";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const repositoryDirectory = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "" &&
  !value.includes("\\") &&
  !value.includes("${{") &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  }) &&
  !/^[A-Za-z]:/.test(value) &&
  !path.posix.isAbsolute(value) &&
  (value === "." ||
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".."));

const packageDirectories = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(repositoryDirectory) &&
  new Set(value).size === value.length;

const nightlySchedule = (value: unknown) => {
  if (!record(value)) return false;
  const schedule = value["schedule"];
  return (
    Array.isArray(schedule) &&
    schedule.length > 0 &&
    schedule.every(
      (entry: unknown) =>
        record(entry) &&
        typeof entry["cron"] === "string" &&
        entry["cron"].trim().split(/\s+/).length === 5,
    )
  );
};

export type ConsumerCheck = {
  workflow: string;
  job: string;
  packages: string[];
};

export const parseConsumerChecks = (input: unknown): ConsumerCheck[] => {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("consumerChecks must be an array");
  const targets = new Set<string>();
  return input.map((entry: unknown) => {
    if (
      !record(entry) ||
      Object.keys(entry).some(
        (key) => !["workflow", "job", "packages"].includes(key),
      ) ||
      typeof entry["workflow"] !== "string" ||
      githubAutomationFileKind(entry["workflow"]) !== "workflow" ||
      !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry["workflow"]) ||
      typeof entry["job"] !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(entry["job"]) ||
      !packageDirectories(entry["packages"])
    )
      throw new Error(
        "consumerChecks requires canonical workflow, job and unique package directories",
      );
    const target = `${entry["workflow"]}:${entry["job"]}`;
    if (targets.has(target))
      throw new Error("consumerChecks targets must be unique");
    targets.add(target);
    return {
      workflow: entry["workflow"],
      job: entry["job"],
      packages: entry["packages"],
    };
  });
};

type CheckConsumerChecksOptions = {
  declarations: readonly ConsumerCheck[];
  files: Record<string, string>;
  policy: {
    consumerNode: string;
    actions: Record<string, { sha: string; version: string }>;
  };
};

/** Consumer checks are scoped declarations, never general runtime exceptions. */
export const checkConsumerChecks = ({
  declarations,
  files,
  policy,
}: CheckConsumerChecksOptions) => {
  const diagnostics: {
    rule: "configuration";
    path: string;
    line: number;
    message: string;
  }[] = [];
  const exercised = new Set<ConsumerCheck>();
  const add = (message: string) =>
    diagnostics.push({
      rule: "configuration",
      path: "stll-toolchain.json",
      line: 1,
      message,
    });
  for (const [workflow, text] of Object.entries(files)) {
    if (githubAutomationFileKind(workflow) !== "workflow") continue;
    try {
      const document = parseDocument(text, { uniqueKeys: true, merge: true });
      if (document.errors.length > 0) throw new Error("invalid workflow YAML");
      const source: unknown = document.toJS({ maxAliasCount: 100 });
      if (!record(source) || !record(source["jobs"])) continue;
      for (const [jobName, job] of Object.entries(source["jobs"])) {
        if (!record(job) || typeof job["uses"] !== "string") continue;
        const [workflowPath, ref] = job["uses"].split("@");
        if (workflowPath?.toLowerCase() !== consumerCheckWorkflow) continue;
        const declaration = declarations.find(
          (entry) => entry.workflow === workflow && entry.job === jobName,
        );
        if (declaration === undefined) {
          add(`${workflow}:${jobName} requires a consumerChecks declaration`);
          continue;
        }
        if (!nightlySchedule(source["on"]))
          throw new Error(
            `${workflow} consumer checks require a nonempty valid on.schedule`,
          );
        if ("if" in job)
          throw new Error(
            `${workflow}:${jobName} consumer checks require an unconditional reusable job without if`,
          );
        exercised.add(declaration);
        const approved = Object.entries(policy.actions).find(
          ([name]) => name.toLowerCase() === consumerCheckWorkflow,
        )?.[1];
        if (
          job["uses"].split("@").length !== 2 ||
          ref === undefined ||
          !/^[a-f0-9]{40}$/.test(ref) ||
          approved === undefined ||
          ref !== approved.sha ||
          "steps" in job ||
          "runs-on" in job
        )
          throw new Error(
            `${workflow}:${jobName} must invoke the approved immutable consumer workflow as a reusable job`,
          );
        const inputs = job["with"];
        if (!record(inputs))
          throw new Error(`${workflow}:${jobName} requires consumer inputs`);
        const names = new Set<string>();
        for (const key of Object.keys(inputs)) {
          const normalized = key.toLowerCase();
          if (
            names.has(normalized) ||
            ((normalized === "packages" || normalized === "consumer-node") &&
              normalized !== key)
          )
            throw new Error(
              `${workflow}:${jobName} requires unique canonical consumer input names`,
            );
          names.add(normalized);
        }
        if (inputs["consumer-node"] !== policy.consumerNode)
          throw new Error(
            `${workflow}:${jobName} consumer-node must be ${policy.consumerNode}`,
          );
        const rawPackages = inputs["packages"];
        if (typeof rawPackages !== "string")
          throw new Error(
            `${workflow}:${jobName} packages must be a static JSON array`,
          );
        const selected: unknown = JSON.parse(rawPackages);
        if (
          !packageDirectories(selected) ||
          selected.length !== declaration.packages.length ||
          !selected.every((directory) =>
            declaration.packages.includes(directory),
          )
        )
          throw new Error(
            `${workflow}:${jobName} packages must exactly match consumerChecks`,
          );
        const workspacePackages = new Map(
          [...discoverConsumerPackages(files).values()].map((entry) => [
            entry.directory,
            entry.manifest,
          ]),
        );
        for (const directory of declaration.packages) {
          const manifestPath = path.posix.join(directory, "package.json");
          const manifestText = files[manifestPath];
          if (manifestText === undefined)
            throw new Error(
              `consumerChecks package manifest must be tracked: ${manifestPath}`,
            );
          const manifest = workspacePackages.get(directory);
          if (manifest === undefined)
            throw new Error(
              `consumerChecks package must be a discovered workspace member: ${manifestPath}`,
            );
          if (
            manifest["private"] === true ||
            typeof manifest["name"] !== "string" ||
            manifest["name"].trim() === ""
          )
            throw new Error(
              `consumerChecks requires a named published package: ${manifestPath}`,
            );
          const engines = manifest["engines"];
          if (
            (engines !== undefined && !record(engines)) ||
            !consumerNodeSupportMatches({
              range: record(engines) ? engines["node"] : undefined,
              node: policy.consumerNode,
            })
          )
            throw new Error(
              `${manifestPath} engines.node must support consumer Node ${policy.consumerNode}`,
            );
        }
      }
    } catch (error) {
      if (
        declarations.some((entry) => entry.workflow === workflow) ||
        text.toLowerCase().includes(consumerCheckWorkflow)
      )
        add(error instanceof Error ? error.message : String(error));
    }
  }
  for (const declaration of declarations)
    if (!exercised.has(declaration))
      add(
        `${declaration.workflow}:${declaration.job} consumerChecks declaration has no matching reusable invocation`,
      );
  return diagnostics;
};
