import { valid } from "semver";

import { parseFormatterPolicy } from "./toolchain-formatter";
import { nodePolicyValid } from "./toolchain-node";

export const packagePinKeys = [
  "oxlint",
  "oxlint-tsgolint",
  "@oxlint/plugins",
  "@stll/oxlint-plugin",
  "lefthook",
] as const;

export const valkeyArchitectures = ["amd64", "arm64"] as const;
export const valkeyArtifactPackages = {
  server: "valkey-server",
  tools: "valkey-tools",
} as const;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseArchiveSha256 = (input: unknown, label: string) => {
  if (input === undefined) return {};
  if (!record(input)) throw new Error(`${label} must be a version map`);
  const releases: Record<string, { amd64: string; arm64: string }> = {};
  for (const [version, value] of Object.entries(input)) {
    if (valid(version) !== version || !record(value))
      throw new Error(`${label} requires exact release keys`);
    const keys = Object.keys(value);
    if (keys.length !== 2 || !keys.includes("amd64") || !keys.includes("arm64"))
      throw new Error(`${label} ${version} requires amd64 and arm64 pins`);
    const amd64 = value["amd64"];
    const arm64 = value["arm64"];
    if (
      typeof amd64 !== "string" ||
      typeof arm64 !== "string" ||
      !/^[a-f0-9]{64}$/.test(amd64) ||
      !/^[a-f0-9]{64}$/.test(arm64)
    )
      throw new Error(`${label} ${version} requires lowercase SHA256 pins`);
    releases[version] = { amd64, arm64 };
  }
  return releases;
};

const artifactRecord = (value: unknown, keys: readonly string[]) => {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error(
      "valkeyArtifacts requires complete, closed artifact objects",
    );
  return value;
};

const parseValkeyArtifacts = (input: unknown, version: string) => {
  const architectures = artifactRecord(input, valkeyArchitectures);
  const line = version.split(".").slice(0, 2).join(".");
  const parseArchitecture = (
    architecture: (typeof valkeyArchitectures)[number],
  ) => {
    const packages = artifactRecord(
      architectures[architecture],
      Object.keys(valkeyArtifactPackages),
    );
    const parseArtifact = (kind: keyof typeof valkeyArtifactPackages) => {
      const artifact = artifactRecord(packages[kind], ["url", "sha256"]);
      const url = artifact["url"];
      const sha256 = artifact["sha256"];
      const expected = `https://download.valkey.io/packaging/valkey-${line}/deb/ubuntu2404/${architecture}/${valkeyArtifactPackages[kind]}_${version}-1.noble_${architecture}.deb`;
      if (typeof url !== "string" || url !== expected)
        throw new Error(
          "valkeyArtifacts URL must select the exact official versioned Ubuntu artifact",
        );
      if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256))
        throw new Error("valkeyArtifacts requires a lowercase SHA256 pin");
      return { url, sha256 };
    };
    return {
      server: parseArtifact("server"),
      tools: parseArtifact("tools"),
    } satisfies Record<
      keyof typeof valkeyArtifactPackages,
      ReturnType<typeof parseArtifact>
    >;
  };
  return {
    amd64: parseArchitecture("amd64"),
    arm64: parseArchitecture("arm64"),
  } satisfies Record<
    (typeof valkeyArchitectures)[number],
    ReturnType<typeof parseArchitecture>
  >;
};

/** Reject unsupported or incomplete installed policies before inspecting a consumer. */
export const parseToolchainPolicy = (input: unknown) => {
  if (!record(input) || input["schemaVersion"] !== 1)
    throw new Error("toolchain.json must use schemaVersion 1");
  const string = (object: Record<string, unknown>, key: string) => {
    const value = object[key];
    if (typeof value !== "string" || value.trim() === "")
      throw new Error(`toolchain.json requires a nonempty ${key}`);
    return value;
  };
  const packages: Record<string, string> = {};
  for (const key of packagePinKeys) packages[key] = string(input, key);
  const bun = string(input, "bun");
  const bunArchiveSha256 = parseArchiveSha256(
    input["bunArchiveSha256"],
    "bunArchiveSha256",
  );
  const typescript = string(input, "typescript");
  const node = string(input, "node");
  const nodeArchiveSha256 = parseArchiveSha256(
    input["nodeArchiveSha256"],
    "nodeArchiveSha256",
  );
  const consumerNode = string(input, "consumerNode");
  const consumerNpm = string(input, "consumerNpm");
  const consumerPnpm = string(input, "consumerPnpm");
  const consumerTypescript = string(input, "consumerTypescript");
  const python = string(input, "python");
  const postgres = string(input, "postgres");
  const valkey = string(input, "valkey");
  const rust = string(input, "rust");
  for (const [name, value] of Object.entries({
    ...packages,
    bun,
    typescript,
    consumerNpm,
    consumerPnpm,
    consumerTypescript,
  }))
    if (valid(value) !== value)
      throw new Error(`toolchain.json ${name} must be an exact release`);
  if (!/^[1-9]\d*$/.test(postgres) || !Number.isSafeInteger(Number(postgres)))
    throw new Error("PostgreSQL must be a canonical positive major");
  if (valid(valkey) !== valkey || !/^\d+\.\d+\.\d+$/.test(valkey))
    throw new Error("Valkey must be an exact stable release");
  const valkeyArtifacts = parseValkeyArtifacts(
    input["valkeyArtifacts"],
    valkey,
  );
  if (!nodePolicyValid(node))
    throw new Error("Node must be a canonical major N.x series");
  if (
    valid(consumerNode) !== consumerNode ||
    !consumerNode.startsWith("22.") ||
    consumerNode.includes("-") ||
    consumerNode.includes("+")
  )
    throw new Error("consumerNode must be an exact stable Node 22 release");
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(python))
    throw new Error("Python must be an exact minor or patch release");
  if (!/^\d+\.\d+\.\d+$/.test(rust))
    throw new Error("Rust must be an exact stable release");
  if (
    !consumerTypescript.startsWith("6.") ||
    consumerTypescript.includes("-") ||
    consumerTypescript.includes("+")
  )
    throw new Error(
      "consumerTypescript must be an exact stable TypeScript 6 release",
    );
  const compatibility = input["typescript6Compatibility"];
  if (!record(compatibility))
    throw new Error("missing TypeScript compatibility policy");
  const version = string(compatibility, "version");
  const packageAlias = string(compatibility, "packageAlias");
  if (valid(version) !== version || !version.startsWith("6."))
    throw new Error(
      "TypeScript compatibility must be an exact TypeScript 6 release",
    );
  const blockers = compatibility["peerBlockers"];
  if (
    !Array.isArray(blockers) ||
    blockers.length === 0 ||
    !blockers.every(
      (blocker: unknown) => typeof blocker === "string" && blocker !== "",
    )
  )
    throw new Error(
      "TypeScript compatibility must list its peer blockers as nonempty package names",
    );
  const peerBlockers: readonly string[] = blockers;
  const actionsInput = input["actions"];
  if (!record(actionsInput) || Object.keys(actionsInput).length === 0)
    throw new Error("missing approved actions");
  const actions: Record<string, { sha: string; version: string }> = {};
  for (const [name, action] of Object.entries(actionsInput)) {
    if (!record(action)) throw new Error(`invalid action policy: ${name}`);
    const sha = string(action, "sha");
    const actionVersion = string(action, "version");
    if (!/^[a-f0-9]{40}$/.test(sha) || !/^v\d+(?:\.\d+)*$/.test(actionVersion))
      throw new Error(`invalid action SHA/version: ${name}`);
    actions[name] = { sha, version: actionVersion };
  }
  const dependabotInput = input["dependabot"];
  if (
    !record(dependabotInput) ||
    !record(dependabotInput["schedule"]) ||
    !record(dependabotInput["cooldown"]) ||
    !record(dependabotInput["groups"])
  )
    throw new Error("missing Dependabot policy");
  const scheduleInput = dependabotInput["schedule"];
  const schedule = {
    interval: string(scheduleInput, "interval"),
    day: string(scheduleInput, "day"),
    time: string(scheduleInput, "time"),
    timezone: string(scheduleInput, "timezone"),
  };
  const defaultDays = dependabotInput["cooldown"]["defaultDays"];
  if (
    typeof defaultDays !== "number" ||
    !Number.isInteger(defaultDays) ||
    defaultDays < 5
  )
    throw new Error("Dependabot cooldown must be at least five days");
  const strings = (value: unknown): string[] => {
    if (
      !Array.isArray(value) ||
      !value.every((entry: unknown) => typeof entry === "string")
    )
      throw new Error("Dependabot group values must be string arrays");
    return value;
  };
  // First-party reusable workflows move by commit, without a semver update
  // type, and must land together; they precede the shared semver groups.
  const actionGroupsInput = dependabotInput["actionGroups"];
  if (!record(actionGroupsInput))
    throw new Error("missing Dependabot action groups");
  const actionGroups: Record<string, { patterns: string[] }> = {};
  for (const [name, group] of Object.entries(actionGroupsInput)) {
    if (!record(group) || Object.keys(group).some((key) => key !== "patterns"))
      throw new Error(`invalid Dependabot action group: ${name}`);
    actionGroups[name] = { patterns: strings(group["patterns"]) };
  }
  const groups: Record<string, { patterns: string[]; updateTypes: string[] }> =
    {};
  for (const [name, group] of Object.entries(dependabotInput["groups"])) {
    if (!record(group)) throw new Error(`invalid Dependabot group: ${name}`);
    groups[name] = {
      patterns: strings(group["patterns"]),
      updateTypes: strings(group["updateTypes"]),
    };
  }
  return {
    bun,
    bunArchiveSha256,
    formatter: parseFormatterPolicy(input["formatter"]),
    typescript,
    node,
    nodeArchiveSha256,
    postgres,
    valkey,
    valkeyArtifacts,
    consumerNode,
    consumerNpm,
    consumerPnpm,
    consumerTypescript,
    python,
    rust,
    packages,
    actions,
    typescript6Compatibility: { version, packageAlias, peerBlockers },
    dependabot: {
      schedule,
      cooldown: { defaultDays },
      actionGroups,
      groups,
      ignoredPackages: [
        ...new Set([
          ...Object.keys(packages),
          // The consumer package managers move only with a reviewed
          // consumerNpm or consumerPnpm change.
          "npm",
          "pnpm",
          // TypeScript 6 moves only with a reviewed compatibility change;
          // the native compiler package stays retired.
          "typescript",
          "@typescript/native",
          packageAlias,
          "bun-types",
        ]),
      ],
      ignoredActions: Object.keys(actions),
      ignoredImages: ["node", "python", "oven/bun"],
    },
  };
};
