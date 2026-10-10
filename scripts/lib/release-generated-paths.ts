/** Canonical outputs owned by the workspace version synchronizer. */
export const workspaceVersionOutputs = {
  lockfile: "bun.lock",
  toolchain: "packages/oxlint-config/toolchain.json",
} as const;

export const releaseGeneratedPaths = (
  packageDirectories: readonly string[],
) => [
  ...Object.values(workspaceVersionOutputs),
  ...packageDirectories.flatMap((directory) => [
    `packages/${directory}/CHANGELOG.md`,
    `packages/${directory}/package.json`,
  ]),
];
