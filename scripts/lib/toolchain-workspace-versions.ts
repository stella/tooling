type SyncWorkspaceToolchainPinsOptions = {
  policyText: string;
  workspaceVersions: ReadonlyMap<string, string>;
};

/** Release metadata owns versions of tools published by this workspace. */
export const syncWorkspaceToolchainPins = ({
  policyText,
  workspaceVersions,
}: SyncWorkspaceToolchainPinsOptions) => {
  const policy: unknown = JSON.parse(policyText);
  if (typeof policy !== "object" || policy === null || Array.isArray(policy))
    throw new Error("toolchain.json must contain an object");
  const mismatches: { name: string; expected: string; actual: unknown }[] = [];
  for (const [name, expected] of workspaceVersions) {
    if (!(name in policy)) continue;
    const actual: unknown = Reflect.get(policy, name);
    if (actual === expected) continue;
    mismatches.push({ name, expected, actual });
    Reflect.set(policy, name, expected);
  }
  return {
    text:
      mismatches.length === 0
        ? policyText
        : `${JSON.stringify(policy, null, 2)}\n`,
    mismatches,
  };
};
