import { satisfies, validRange } from "semver";

type ConsumerNodeSupportOptions = { range: unknown; node: string };

export const consumerNodeSupportMatches = ({
  range,
  node,
}: ConsumerNodeSupportOptions) =>
  range === undefined ||
  (typeof range === "string" &&
    range.trim() !== "" &&
    validRange(range) !== null &&
    satisfies(node, range));

type AssertConsumerNodeSupportOptions = {
  manifest: Record<string, unknown>;
  node: string;
  label: string;
};
export const assertConsumerNodeSupport = ({
  manifest,
  node,
  label,
}: AssertConsumerNodeSupportOptions) => {
  const engines = manifest["engines"];
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (
    (engines !== undefined && !record(engines)) ||
    !consumerNodeSupportMatches({
      range: record(engines) ? engines["node"] : undefined,
      node,
    })
  )
    throw new Error(`${label} engines.node must support consumer Node ${node}`);
};
