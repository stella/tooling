import path from "node:path";
import { parseDocument } from "yaml";

import packageMetadata from "../package.json";
import {
  assertConsumerFixtureSelection,
  assertConsumerFixtureKind,
  consumerPackageClosure,
  parseConsumerFixtures,
  discoverConsumerPackages,
} from "./consumer-compat-config";
import { assertConsumerNodeSupport } from "./consumer-node-support";
import { githubAutomationFileKind } from "./toolchain-inputs";

export const consumerRunnerVersion = packageMetadata.version;

export const consumerCheckWorkflow =
  "stella/.github/.github/workflows/package-consumer-compat.yml";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const repositoryDirectory = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "" &&
  !value.includes("\\") &&
  !value.includes("${{") &&
  !value.split("").some((character) => {
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

type CronField = {
  minimum: number;
  maximum: number;
  names?: Record<string, number>;
};
const cronFields = [
  { minimum: 0, maximum: 59 },
  { minimum: 0, maximum: 23 },
  { minimum: 1, maximum: 31 },
  {
    minimum: 1,
    maximum: 12,
    names: Object.fromEntries(
      [
        "JAN",
        "FEB",
        "MAR",
        "APR",
        "MAY",
        "JUN",
        "JUL",
        "AUG",
        "SEP",
        "OCT",
        "NOV",
        "DEC",
      ].map((name, index) => [name, index + 1]),
    ),
  },
  {
    minimum: 0,
    maximum: 6,
    names: Object.fromEntries(
      ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((name, index) => [
        name,
        index,
      ]),
    ),
  },
] as const;
const cronFieldValues = (text: string, field: CronField) => {
  const value = (token: string) => {
    const number = /^\d+$/.test(token)
      ? Number(token)
      : field.names?.[token.toUpperCase()];
    return number !== undefined &&
      Number.isSafeInteger(number) &&
      number >= field.minimum &&
      number <= field.maximum
      ? number
      : undefined;
  };
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const split = part.split("/");
    if (split.length > 2) return undefined;
    const [base, stepText] = split;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (stepText !== undefined && !/^\d+$/.test(stepText)) return undefined;
    if (!Number.isSafeInteger(step) || step <= 0 || base === undefined)
      return undefined;
    const bounds = base.split("-");
    if (bounds.length > 2) return undefined;
    const lower = bounds.at(0);
    const start =
      base === "*"
        ? field.minimum
        : lower === undefined
          ? undefined
          : value(lower);
    const upper = bounds.at(1);
    const end =
      base === "*" || (bounds.length === 1 && stepText !== undefined)
        ? field.maximum
        : upper === undefined
          ? start
          : value(upper);
    if (start === undefined || end === undefined || start > end)
      return undefined;
    for (let selected = start; selected <= end; selected += step)
      values.add(selected);
  }
  return values;
};

const validConsumerCron = (text: string) => {
  const fields = text.trim().split(/\s+/);
  return (
    fields.length === cronFields.length &&
    cronFields.every((field, index) => {
      const text = fields.at(index);
      return text !== undefined && cronFieldValues(text, field) !== undefined;
    })
  );
};

const nightlySchedule = (value: unknown) => {
  if (!record(value)) return false;
  const schedule = value["schedule"];
  if (!Array.isArray(schedule) || schedule.length === 0) return false;
  const coveredDays = new Set<number>();
  for (const entry of schedule) {
    if (
      !record(entry) ||
      typeof entry["cron"] !== "string" ||
      !validConsumerCron(entry["cron"])
    )
      return false;
    const fields = entry["cron"].trim().split(/\s+/);
    const selections = cronFields.map((field, index) => {
      const text = fields.at(index);
      return text === undefined ? undefined : cronFieldValues(text, field);
    });
    // Month and date restrictions cannot certify a daily schedule.
    if (selections.at(2)?.size !== 31 || selections.at(3)?.size !== 12)
      continue;
    for (const day of selections.at(4) ?? []) coveredDays.add(day);
  }
  return coveredDays.size === 7;
};

export type ConsumerCheck = {
  workflow: string;
  job: string;
  packages: string[];
  toolingVersion: string;
  fixturePath: string;
};

export const parseConsumerChecks = (input: unknown): ConsumerCheck[] => {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("consumerChecks must be an array");
  const targets = new Set<string>();
  return input.map((entry: unknown) => {
    if (
      !record(entry) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "workflow",
            "job",
            "packages",
            "toolingVersion",
            "fixturePath",
          ].includes(key),
      ) ||
      typeof entry["workflow"] !== "string" ||
      githubAutomationFileKind(entry["workflow"]) !== "workflow" ||
      !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry["workflow"]) ||
      typeof entry["job"] !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(entry["job"]) ||
      !packageDirectories(entry["packages"]) ||
      typeof entry["toolingVersion"] !== "string" ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
        entry["toolingVersion"],
      ) ||
      !repositoryDirectory(entry["fixturePath"])
    )
      throw new Error(
        "consumerChecks requires canonical workflow, job, unique package directories, exact toolingVersion and repository-relative fixturePath",
      );
    const target = `${entry["workflow"]}:${entry["job"]}`;
    if (targets.has(target))
      throw new Error("consumerChecks targets must be unique");
    targets.add(target);
    return {
      workflow: entry["workflow"],
      job: entry["job"],
      packages: entry["packages"],
      toolingVersion: entry["toolingVersion"],
      fixturePath: entry["fixturePath"],
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
            `${workflow} consumer checks require a nonempty valid on.schedule covering every day`,
          );
        if ("if" in job || "needs" in job || "strategy" in job)
          throw new Error(
            `${workflow}:${jobName} consumer checks require a stand-alone unconditional reusable job without if or needs or strategy`,
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
            ![
              "packages",
              "consumer-node",
              "tooling-version",
              "fixture-path",
            ].includes(normalized) ||
            normalized !== key
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
        if (declaration.toolingVersion !== consumerRunnerVersion)
          throw new Error(
            `${workflow}:${jobName} toolingVersion must match installed @stll/oxlint-config ${consumerRunnerVersion}`,
          );
        if (inputs["tooling-version"] !== declaration.toolingVersion)
          throw new Error(
            `${workflow}:${jobName} tooling-version must match consumerChecks.toolingVersion`,
          );
        if (inputs["fixture-path"] !== declaration.fixturePath)
          throw new Error(
            `${workflow}:${jobName} fixture-path must match consumerChecks.fixturePath`,
          );
        const fixtureManifest = path.posix.join(
          declaration.fixturePath,
          "consumer-compat.json",
        );
        const fixtureSource = files[fixtureManifest];
        if (fixtureSource === undefined)
          throw new Error(
            `consumerChecks fixture configuration must be tracked: ${fixtureManifest}`,
          );
        const fixtureConfiguration: unknown = JSON.parse(fixtureSource);
        const fixtures = parseConsumerFixtures(fixtureConfiguration);
        assertConsumerFixtureSelection({
          selected: declaration.packages,
          fixtures,
        });
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
        const workspacePackages = discoverConsumerPackages(files);
        const packagesByDirectory = new Map(
          [...workspacePackages.values()].map((entry) => [
            entry.directory,
            entry,
          ]),
        );
        for (const directory of declaration.packages) {
          const manifestPath = path.posix.join(directory, "package.json");
          const manifestText = files[manifestPath];
          if (manifestText === undefined)
            throw new Error(
              `consumerChecks package manifest must be tracked: ${manifestPath}`,
            );
          const selectedPackage = packagesByDirectory.get(directory);
          if (selectedPackage === undefined)
            throw new Error(
              `consumerChecks package must be a discovered workspace member: ${manifestPath}`,
            );
          const fixture = fixtures.find(
            (candidate) => candidate.package === directory,
          );
          if (fixture === undefined)
            throw new Error(`missing declared consumer fixture: ${directory}`);
          assertConsumerFixtureKind({ fixture, pkg: selectedPackage });
          const manifest = selectedPackage.manifest;
          if (
            manifest["private"] === true ||
            typeof manifest["name"] !== "string" ||
            manifest["name"].trim() === ""
          )
            throw new Error(
              `consumerChecks requires a named published package: ${manifestPath}`,
            );
          const closure = consumerPackageClosure({
            selected: selectedPackage,
            packages: workspacePackages,
            files,
          });
          for (const member of closure.values())
            assertConsumerNodeSupport({
              manifest: member.manifest,
              node: policy.consumerNode,
              label: path.posix.join(member.directory, "package.json"),
            });
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
