import { valid } from "semver";

export type ArchivePins = Readonly<
  Record<string, { readonly amd64: string; readonly arm64: string }>
>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parse a map from exact releases to their amd64 and arm64 archive SHA256 values. */
export const parseArchiveSha256 = (
  input: unknown,
  label: string,
): ArchivePins => {
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
