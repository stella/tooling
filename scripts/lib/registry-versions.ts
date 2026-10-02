export type ReleaseVersionCheck =
  | { status: "published" }
  | { status: "first-release" }
  | { status: "ascending"; highest: string }
  | { status: "regression"; highest: string };

export type ReleaseVersionInput = {
  version: string;
  publishedVersions: readonly string[];
};

const highestVersion = (versions: readonly string[]): string | null => {
  let highest: string | null = null;
  for (const version of versions) {
    if (highest === null || Bun.semver.order(version, highest) > 0) {
      highest = version;
    }
  }
  return highest;
};

/**
 * Classify a manifest version against the versions already on the registry.
 *
 * An already-published version is not a release candidate. Any other version
 * must sort above every published version: the release pipeline publishes with
 * an explicit dist-tag, so npm would otherwise move `latest` backwards.
 */
export const checkReleaseVersion = ({
  version,
  publishedVersions,
}: ReleaseVersionInput): ReleaseVersionCheck => {
  if (publishedVersions.includes(version)) return { status: "published" };
  const highest = highestVersion(publishedVersions);
  if (highest === null) return { status: "first-release" };
  if (Bun.semver.order(version, highest) > 0) {
    return { status: "ascending", highest };
  }
  return { status: "regression", highest };
};

// `npm view <name> versions --json` prints a bare string for one version.
export const parseNpmVersions = (stdout: string): string[] => {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed === "string") return [parsed];
  if (!Array.isArray(parsed)) {
    throw new TypeError("npm view versions did not return a list.");
  }
  const values: unknown[] = parsed;
  const versions = values.filter(
    (value): value is string => typeof value === "string",
  );
  if (versions.length !== values.length) {
    throw new TypeError("npm view versions returned a non-string version.");
  }
  return versions;
};
