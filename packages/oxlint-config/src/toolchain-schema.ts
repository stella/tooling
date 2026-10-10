import { valid } from "semver";

export const packagePinKeys = [
  "oxlint",
  "oxlint-tsgolint",
  "@oxlint/plugins",
  "@stll/oxlint-plugin",
  "oxfmt",
  "lefthook",
] as const;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  const typescript = string(input, "typescript");
  const node = string(input, "node");
  const python = string(input, "python");
  const rust = string(input, "rust");
  const rustCompilerDevelopment = string(input, "rustCompilerDevelopment");
  for (const [name, value] of Object.entries({
    ...packages,
    bun,
    typescript,
    node,
  }))
    if (valid(value) !== value)
      throw new Error(`toolchain.json ${name} must be an exact release`);
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(python))
    throw new Error("Python must be an exact minor or patch release");
  if (!/^\d+\.\d+\.\d+$/.test(rust))
    throw new Error("Rust must be an exact stable release");
  if (!/^nightly-\d{4}-\d{2}-\d{2}$/.test(rustCompilerDevelopment))
    throw new Error("Rust compiler development must be a dated nightly");
  const compatibility = input["typescript6Compatibility"];
  if (!record(compatibility))
    throw new Error("missing TypeScript compatibility policy");
  const version = string(compatibility, "version");
  const packageAlias = string(compatibility, "packageAlias");
  if (valid(version) !== version)
    throw new Error("TypeScript compatibility must be an exact release");
  const layouts = input["typescriptInstallLayouts"];
  if (!Array.isArray(layouts) || layouts.length === 0)
    throw new Error("missing TypeScript install layouts");
  const typescriptInstallLayouts = layouts.map((layout: unknown) => {
    if (!record(layout)) throw new Error("invalid TypeScript install layout");
    const compilerPackage = string(layout, "compilerPackage");
    const compilerSpecifier = string(layout, "compilerSpecifier");
    const typecheckCommand = string(layout, "typecheckCommand");
    switch (layout["type"]) {
      case "direct":
        if (
          compilerSpecifier !== typescript ||
          compilerPackage !== "typescript"
        )
          throw new Error(
            "direct TypeScript layout differs from shared version",
          );
        return {
          type: "direct",
          compilerPackage,
          compilerSpecifier,
          typecheckCommand,
        } as const;
      case "split-compatibility": {
        const compatibilityPackage = string(layout, "compatibilityPackage");
        const compatibilitySpecifier = string(layout, "compatibilitySpecifier");
        if (
          compilerSpecifier !== `npm:typescript@${typescript}` ||
          compatibilitySpecifier !== version
        )
          throw new Error(
            "split TypeScript layout differs from shared versions",
          );
        return {
          type: "split-compatibility",
          compilerPackage,
          compilerSpecifier,
          compatibilityPackage,
          compatibilitySpecifier,
          typecheckCommand,
        } as const;
      }
      default:
        throw new Error("unsupported TypeScript install layout");
    }
  });
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
    typescript,
    node,
    python,
    rust,
    rustCompilerDevelopment,
    packages,
    actions,
    typescriptInstallLayouts,
    typescript6Compatibility: { version, packageAlias },
    dependabot: {
      schedule,
      cooldown: { defaultDays },
      groups,
      ignoredPackages: [
        ...new Set([
          ...Object.keys(packages),
          ...typescriptInstallLayouts.flatMap((layout) =>
            layout.type === "direct"
              ? [layout.compilerPackage]
              : [layout.compilerPackage, layout.compatibilityPackage],
          ),
          packageAlias,
          "bun-types",
        ]),
      ],
      ignoredActions: Object.keys(actions),
      ignoredImages: ["node", "python", "oven/bun"],
    },
  };
};
