export const cloudServices = ["postgres", "valkey"] as const;
export type CloudService = (typeof cloudServices)[number];
export const cloudInstallCommand = "bun install --frozen-lockfile";

const cloudService = (value: unknown): value is CloudService =>
  cloudServices.some((service) => value === service);

/** Parse an explicit declaration without assuming services for undeclared repositories. */
export const parseCloudSetup = (input: unknown) => {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("cloud must be an object");
  for (const key of Object.keys(input))
    if (key !== "services" && key !== "install" && key !== "envFile")
      throw new Error(`unsupported cloud key: ${key}`);
  if (!("services" in input) || !Array.isArray(input.services))
    throw new Error("cloud.services must be an explicit array");
  if (!("install" in input) || input.install !== cloudInstallCommand)
    throw new Error(`cloud.install must be exactly ${cloudInstallCommand}`);
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
  const seen = new Set<CloudService>();
  const services = Array.from(input.services, (service: unknown) => {
    if (!cloudService(service))
      throw new Error("cloud.services contains an unsupported service");
    if (seen.has(service))
      throw new Error(`cloud.services contains duplicate service: ${service}`);
    seen.add(service);
    return service;
  });
  return { services, install: cloudInstallCommand, envFile } as const;
};
