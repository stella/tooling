import semver from "semver";

export type EnginePackage = {
  name: string;
  node?: string;
  changesetsManaged: boolean;
  optionalDependencies: readonly string[];
};

export type EngineSupportInput = {
  base: ReadonlyMap<string, EnginePackage>;
  head: ReadonlyMap<string, EnginePackage>;
  majorReleases: ReadonlySet<string>;
};

export type EngineSupportFailure = {
  packageName: string;
  baseRange: string;
  headRange: string;
  releasingPackage: string;
};

const displayedRange = (range: string | undefined) => range ?? "unrestricted";

/** Returns engine-support changes that require a pending major release. */
export const checkEngineSupport = ({
  base,
  head,
  majorReleases,
}: EngineSupportInput): EngineSupportFailure[] => {
  const failures: EngineSupportFailure[] = [];
  for (const [name, current] of head) {
    const previous = base.get(name);
    if (previous === undefined) continue;
    const baseRange = previous.node ?? "*";
    const headRange = current.node ?? "*";
    if (semver.subset(baseRange, headRange)) continue;

    const owners = [...head.values()].filter(
      (candidate) =>
        candidate.name !== name &&
        candidate.optionalDependencies.includes(name),
    );
    if (owners.length > 1)
      throw new Error(
        `Multiple releasing packages declare ${name}: ${owners.map(({ name: ownerName }) => ownerName).join(", ")}`,
      );
    const releasingPackage = current.changesetsManaged
      ? name
      : (owners.at(0)?.name ?? name);
    if (majorReleases.has(releasingPackage)) continue;
    failures.push({
      packageName: name,
      baseRange: displayedRange(previous.node),
      headRange: displayedRange(current.node),
      releasingPackage,
    });
  }
  return failures;
};
