import { syncWorkspaceToolchainPins } from "./toolchain-workspace-versions";

const unknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

const POLICY_PACKAGE = "@stll/oxlint-config";

type ToolchainReleaseChangesetOptions = {
  policyText: string;
  releasePlan: unknown;
};

/** Ensure policy changes participate before Changesets computes package versions. */
export const toolchainReleaseChangeset = ({
  policyText,
  releasePlan,
}: ToolchainReleaseChangesetOptions) => {
  if (
    typeof releasePlan !== "object" ||
    releasePlan === null ||
    !("releases" in releasePlan) ||
    !unknownArray(releasePlan.releases)
  )
    throw new Error("Changesets must return a release plan");
  const versions = new Map<string, string>();
  for (const release of releasePlan.releases) {
    if (
      typeof release !== "object" ||
      release === null ||
      !("name" in release) ||
      !("newVersion" in release) ||
      !("type" in release) ||
      typeof release.name !== "string" ||
      typeof release.newVersion !== "string" ||
      !["none", "patch", "minor", "major"].some((type) => type === release.type)
    )
      throw new Error("Changesets must return named, versioned releases");
    if (release.type !== "none") versions.set(release.name, release.newVersion);
  }
  if (versions.has(POLICY_PACKAGE)) return undefined;
  const result = syncWorkspaceToolchainPins({
    policyText,
    workspaceVersions: versions,
  });
  if (result.mismatches.length === 0) return undefined;
  return `---\n"${POLICY_PACKAGE}": patch\n---\n\nSynchronize shared tool pins with workspace releases.\n`;
};
