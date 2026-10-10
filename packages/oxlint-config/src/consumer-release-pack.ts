import { parseDocument } from "yaml";

import { githubAutomationFileKind } from "./toolchain-inputs";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const outputDirectory = "<consumer-release-pack-output>";

export type ConsumerReleasePack = {
  manager: "npm" | "pnpm";
  version: string;
  arguments: string[];
};

const packArguments = (line: string) => {
  const command = /^(npm|pnpm)\s+pack(?:\s+(.*))?$/.exec(line);
  const manager = command?.[1];
  if (manager !== "npm" && manager !== "pnpm")
    throw new Error("Unsupported release pack command");
  const raw = command?.[2] ?? "";
  const tokens = raw.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? [];
  const args: string[] = [];
  let destination = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens.at(index);
    if (token === "--pack-destination") {
      if (destination) throw new Error("Repeated release pack destination");
      const value = tokens.at(++index);
      if (
        value === undefined ||
        !/^(?:"\$GITHUB_WORKSPACE\/[A-Za-z0-9_/-]+"|[A-Za-z0-9_/-]+)$/.test(
          value,
        ) ||
        value.split("/").includes("..")
      )
        throw new Error("Unsupported release pack destination");
      destination = true;
      args.push(token, outputDirectory);
      continue;
    }
    if (
      token !== "--ignore-scripts" &&
      !(manager === "pnpm" && token === "--config.ignore-scripts=true") &&
      token !== "--json" &&
      token !== "--silent"
    )
      throw new Error("Unsupported release pack arguments");
    if (args.includes(token)) throw new Error("Repeated release pack flag");
    args.push(token);
  }
  if (
    !destination ||
    (!args.includes("--ignore-scripts") &&
      !args.includes("--config.ignore-scripts=true"))
  )
    throw new Error(
      "Release pack requires scripts disabled and --pack-destination",
    );
  return { manager, arguments: args } satisfies Pick<
    ConsumerReleasePack,
    "manager" | "arguments"
  >;
};

/** Resolve the repository's release packer without substituting another manager. */
export const resolveConsumerReleasePack = (
  files: Record<string, string>,
): ConsumerReleasePack => {
  const candidates: ConsumerReleasePack[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (githubAutomationFileKind(file) !== "workflow") continue;
    const document = parseDocument(text, { uniqueKeys: true, merge: true });
    if (document.errors.length > 0)
      throw new Error(`Invalid release workflow YAML: ${file}`);
    const source: unknown = document.toJS({ maxAliasCount: 100 });
    if (!record(source) || !record(source["jobs"])) continue;
    for (const [jobName, job] of Object.entries(source["jobs"])) {
      if (!record(job) || !Array.isArray(job["steps"])) continue;
      const packsRelease = job["steps"].some(
        (step: unknown) =>
          record(step) &&
          typeof step["run"] === "string" &&
          step["run"]
            .split("\n")
            .some(
              (line) =>
                !line.trimStart().startsWith("#") &&
                /\b(?:npm|pnpm)\s+pack\b/.test(line),
            ),
      );
      if (!packsRelease) continue;
      const versions = new Map<string, string[]>();
      let packed: ConsumerReleasePack | undefined;
      for (const step of job["steps"]) {
        if (!record(step)) continue;
        if (
          typeof step["uses"] === "string" &&
          step["uses"].startsWith("pnpm/action-setup@")
        ) {
          if (
            step["if"] !== undefined ||
            step["continue-on-error"] !== undefined
          )
            throw new Error(
              `Conditional release packer setup: ${file}:${jobName}`,
            );
          const inputs = step["with"];
          const version = record(inputs) ? inputs["version"] : undefined;
          if (typeof version !== "string" || !exactVersion.test(version))
            throw new Error(
              `Release pnpm setup requires an exact version: ${file}:${jobName}`,
            );
          const values = versions.get("pnpm") ?? [];
          values.push(version);
          versions.set("pnpm", values);
        }
        if (typeof step["run"] !== "string") continue;
        for (const rawLine of step["run"].split("\n")) {
          const line = rawLine.trim();
          if (line.startsWith("#")) continue;
          const setup =
            /^npm\s+install\s+((?:(?:--global|-g|--ignore-scripts)\s+)+)(npm|pnpm)@([^\s]+)$/.exec(
              line,
            );
          if (
            setup !== null &&
            /(?:^|\s)(?:--global|-g)(?:\s|$)/.test(setup[1] ?? "")
          ) {
            if (
              step["if"] !== undefined ||
              step["continue-on-error"] !== undefined
            )
              throw new Error(
                `Conditional release packer setup: ${file}:${jobName}`,
              );
            const manager = setup[2];
            const version = setup[3];
            if (
              manager === undefined ||
              version === undefined ||
              !exactVersion.test(version)
            )
              throw new Error(
                `Release packer setup requires an exact version: ${file}:${jobName}`,
              );
            const values = versions.get(manager) ?? [];
            values.push(version);
            versions.set(manager, values);
          }
          if (!/\b(?:npm|pnpm)\s+pack\b/.test(line)) continue;
          if (
            job["if"] !== undefined ||
            step["if"] !== undefined ||
            step["continue-on-error"] !== undefined ||
            packed !== undefined
          )
            throw new Error(
              `Ambiguous release pack command: ${file}:${jobName}`,
            );
          if (
            (step["shell"] !== undefined &&
              step["shell"] !== "bash" &&
              step["shell"] !== "sh") ||
            step["run"]
              .split("\n")
              .some((context) =>
                /^\s*(?:if|elif|else|fi|for|while|until|case|esac|function)\b/.test(
                  context,
                ),
              )
          )
            throw new Error(
              `Unsupported release pack shell context: ${file}:${jobName}`,
            );
          const command = packArguments(line);
          const selected = versions.get(command.manager);
          const version = selected?.at(0);
          if (selected?.length !== 1 || version === undefined)
            throw new Error(
              `Missing or ambiguous exact release packer version: ${file}:${jobName}`,
            );
          packed = {
            manager: command.manager,
            version,
            arguments: command.arguments,
          };
        }
      }
      if (packed !== undefined) candidates.push(packed);
    }
  }
  const selected = candidates.at(0);
  if (candidates.length !== 1 || selected === undefined)
    throw new Error("Require exactly one identifiable release pack job");
  return selected;
};

type ConsumerReleasePackArgumentsOptions = {
  packer: ConsumerReleasePack;
  directory: string;
};
export const consumerReleasePackArguments = ({
  packer,
  directory,
}: ConsumerReleasePackArgumentsOptions) => {
  if (directory.length === 0)
    throw new Error("Release pack output directory is required");
  return [
    "pack",
    ...packer.arguments.map((argument) =>
      argument === outputDirectory ? directory : argument,
    ),
  ];
};
