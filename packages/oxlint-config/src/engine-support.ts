import semver from "semver";

export type EnginePackage = {
  name: string;
  node?: string;
  changesetsManaged: boolean;
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
    if (!current.changesetsManaged) continue;
    const previous = base.get(name);
    if (previous === undefined) continue;
    const baseRange = previous.node ?? "*";
    const headRange = current.node ?? "*";
    if (semver.subset(baseRange, headRange)) continue;

    if (majorReleases.has(name)) continue;
    failures.push({
      packageName: name,
      baseRange: displayedRange(previous.node),
      headRange: displayedRange(current.node),
    });
  }
  return failures;
};
