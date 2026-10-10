import { compare, satisfies, valid, validRange } from "semver";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type PublishedVersionsOptions = {
  versions: Record<string, unknown>;
  range: string;
};
const publishedVersions = ({ versions, range }: PublishedVersionsOptions) => {
  if (!validRange(range))
    throw new Error(`invalid consumer peer range: ${range}`);
  const candidates = Object.keys(versions)
    .filter((version) => valid(version) !== null && satisfies(version, range))
    .sort(compare);
  if (candidates.length === 0)
    throw new Error(`no published consumer version satisfies ${range}`);
  return candidates;
};

type ConsumerReactVersionsOptions = {
  reactRange: string;
  reactVersions: Record<string, unknown>;
  dom?:
    | {
        range?: string | undefined;
        versions: Record<string, unknown>;
      }
    | undefined;
};

/** Select the oldest published React with a compatible allowed renderer when required. */
export const selectConsumerReactVersions = ({
  reactRange,
  reactVersions,
  dom,
}: ConsumerReactVersionsOptions) => {
  const reactCandidates = publishedVersions({
    versions: reactVersions,
    range: reactRange,
  });
  if (dom === undefined) {
    const react = reactCandidates.at(0);
    if (react === undefined) throw new Error("Missing React version candidate");
    return { react };
  }
  const domRange = dom.range ?? "*";
  const domCandidates = publishedVersions({
    versions: dom.versions,
    range: domRange,
  });
  for (const react of reactCandidates) {
    const renderer = domCandidates.find((version) => {
      const metadata = dom.versions[version];
      if (!record(metadata) || !record(metadata["peerDependencies"]))
        return false;
      const range = metadata["peerDependencies"]["react"];
      return (
        typeof range === "string" &&
        validRange(range) !== null &&
        satisfies(react, range)
      );
    });
    if (renderer !== undefined) return { react, "react-dom": renderer };
  }
  throw new Error(
    `no published React/ReactDOM pair satisfies React ${reactRange} and ReactDOM ${domRange}`,
  );
};
