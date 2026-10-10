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
