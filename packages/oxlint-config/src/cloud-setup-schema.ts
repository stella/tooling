import {
  cloudSetupArtifacts,
  cloudSetupPackages,
  type CloudSetupArtifactTool,
  type CloudSetupPackageTool,
} from "./cloud-setup-artifacts";

export const cloudServices = ["postgres", "valkey"] as const;
export type CloudService = (typeof cloudServices)[number];
export type CloudArtifactTool = Exclude<CloudSetupArtifactTool, "rustup-init">;
export const cloudArtifactTools = Object.keys(cloudSetupArtifacts).filter(
  (tool): tool is CloudArtifactTool =>
    tool !== "rustup-init" && Object.hasOwn(cloudSetupArtifacts, tool),
);
export const cloudPackageTools = Object.keys(cloudSetupPackages).filter(
  (tool): tool is CloudSetupPackageTool =>
    Object.hasOwn(cloudSetupPackages, tool),
);
export type CloudExtraTool = CloudArtifactTool | CloudSetupPackageTool;
export const cloudExtraTools = [...cloudArtifactTools, ...cloudPackageTools];
export const isCloudPackageTool = (
  tool: string,
): tool is CloudSetupPackageTool =>
  cloudPackageTools.some((candidate) => candidate === tool);

const object = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input);
const exactPin = (input: unknown): input is string =>
  typeof input === "string" &&
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(input);
// Upstream releases of distribution packages may omit the patch component.
const exactToolPin = (tool: CloudExtraTool, input: unknown): input is string =>
  isCloudPackageTool(tool)
    ? typeof input === "string" &&
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/.test(input)
    : exactPin(input);

export const cloudRustComponentBinaries = {
  clippy: ["cargo-clippy", "clippy-driver"],
  rustfmt: ["rustfmt", "cargo-fmt"],
  "rust-src": [],
  "rust-analyzer": ["rust-analyzer"],
} as const;
export const parseCloudRustNames = (
  input: unknown,
  kind: "components" | "targets",
) => {
  const label = `cloud Rust ${kind}`;
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`);
  const result = input.map((value: unknown) => {
    if (typeof value !== "string" || !/^[a-z][a-z0-9_-]*$/.test(value))
      throw new Error(`${label} requires canonical names`);
    if (
      kind === "components" &&
      !Object.hasOwn(cloudRustComponentBinaries, value)
    )
      throw new Error(`${label} contains an unsupported component: ${value}`);
    return value;
  });
  if (new Set(result).size !== result.length)
    throw new Error(`${label} contains duplicates`);
  return result;
};
const parseRust = (input: unknown) => {
  if (input === undefined) return undefined;
  if (
    !object(input) ||
    Object.keys(input).some(
      (key) => !["toolchain", "components", "targets"].includes(key),
    )
  )
    throw new Error(
      "cloud.rust accepts only toolchain, components and targets",
    );
  const toolchain = input["toolchain"];
  if (toolchain !== undefined && !exactPin(toolchain))
    throw new Error("cloud.rust.toolchain must be an exact stable release");
  return {
    ...(toolchain === undefined ? {} : { toolchain }),
    components: parseCloudRustNames(input["components"], "components"),
    targets: parseCloudRustNames(input["targets"], "targets"),
  };
};
const parseTools = (input: unknown) => {
  if (input === undefined) return undefined;
  if (
    !object(input) ||
    Object.keys(input).some(
      (key) => !cloudExtraTools.some((tool) => tool === key),
    )
  )
    throw new Error(`cloud.tools accepts only ${cloudExtraTools.join(", ")}`);
  const result: Partial<Record<CloudExtraTool, string>> = {};
  for (const tool of cloudExtraTools) {
    const pin = input[tool];
    if (pin === undefined) {
      if (Object.hasOwn(input, tool))
        throw new Error(`cloud.tools.${tool} must be an exact stable release`);
      continue;
    }
    if (!exactToolPin(tool, pin))
      throw new Error(`cloud.tools.${tool} must be an exact stable release`);
    result[tool] = pin;
  }
  return result;
};

export const cloudInstallCommand = "bun install --frozen-lockfile";

const cloudService = (value: unknown): value is CloudService =>
  cloudServices.some((service) => value === service);

const parseEnvFile = (input: object) => {
  if (!("envFile" in input) || typeof input.envFile !== "string")
    throw new Error(
      "cloud.envFile must be a canonical repository-relative path",
    );
  const envFile = input.envFile;
  if (
    envFile.startsWith("/") ||
    /^[A-Za-z]:/.test(envFile) ||
    envFile.includes("\\") ||
    /\p{Cc}/u.test(envFile) ||
    envFile
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error(
      "cloud.envFile must be a canonical repository-relative path",
    );
  return envFile;
};

/** Parse an explicit declaration without assuming services for undeclared repositories. */
export const parseCloudSetup = (input: unknown) => {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("cloud must be an object");
  for (const key of Object.keys(input))
    if (
      key !== "services" &&
      key !== "install" &&
      key !== "envFile" &&
      key !== "rust" &&
      key !== "tools"
    )
      throw new Error(`unsupported cloud key: ${key}`);
  const rust = parseRust("rust" in input ? input.rust : undefined);
  const tools = parseTools("tools" in input ? input.tools : undefined);
  const extensions = {
    ...(rust === undefined ? {} : { rust }),
    ...(tools === undefined ? {} : { tools }),
  };
  const selected = "services" in input ? input.services : [];
  if (!Array.isArray(selected))
    throw new Error("cloud.services must be an array when provided");
  if (!("install" in input) || input.install !== cloudInstallCommand)
    throw new Error(`cloud.install must be exactly ${cloudInstallCommand}`);
  const seen = new Set<CloudService>();
  const services = Array.from(selected, (service: unknown) => {
    if (!cloudService(service))
      throw new Error("cloud.services contains an unsupported service");
    if (seen.has(service))
      throw new Error(`cloud.services contains duplicate service: ${service}`);
    seen.add(service);
    return service;
  });
  if (services.length === 0 && "envFile" in input)
    throw new Error("cloud.envFile is not allowed without services");
  return {
    services,
    install: cloudInstallCommand,
    ...extensions,
    ...(services.length === 0 ? {} : { envFile: parseEnvFile(input) }),
  } as const;
};
