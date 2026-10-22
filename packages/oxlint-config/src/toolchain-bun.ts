import { gte, valid } from "semver";

// Stable releases only: a prerelease never satisfies the shared minimum.
const STABLE_RELEASE = /^\d+\.\d+\.\d+$/u;

/**
 * The shared policy names the minimum Bun. A repository pins one exact
 * release at or above it in its root packageManager, and every other Bun
 * reference in the repository must equal that release.
 */
export const repositoryBun = (floor: string, manifest: string | undefined) => {
  let packageManager: unknown;
  try {
    const parsed: unknown = JSON.parse(manifest ?? "");
    if (typeof parsed === "object" && parsed !== null)
      packageManager = Reflect.get(parsed, "packageManager");
  } catch {
    // Manifest diagnostics report a malformed root package.json.
  }
  const version =
    typeof packageManager === "string"
      ? /^bun@(.+)$/.exec(packageManager)?.[1]
      : undefined;
  return version !== undefined &&
    STABLE_RELEASE.test(version) &&
    valid(version) === version &&
    gte(version, floor)
    ? version
    : floor;
};

/** A selected runtime satisfies the policy when it is an exact release at or above the floor. */
export const satisfiesBunFloor = (version: string, floor: string) =>
  STABLE_RELEASE.test(version) &&
  valid(version) === version &&
  gte(version, floor);
