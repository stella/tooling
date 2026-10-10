import { subset, validRange } from "semver";

const numericComponent = "(?:0|[1-9]\\d*)";
const policyPattern = new RegExp(`^${numericComponent}\\.x$`);
const selectorPattern = new RegExp(
  `^(${numericComponent})(?:\\.(?:x|${numericComponent}(?:\\.${numericComponent})?))?$`,
);

/** A Node policy selects the complete stable release series of one major. */
export const nodePolicyValid = (value: string) =>
  policyPattern.test(value) && validRange(value) !== null;

/** Static selectors may narrow that series, but cannot float across majors. */
export const nodeSelectorMatches = (value: unknown, policy: string) => {
  if (!nodePolicyValid(policy) || typeof value !== "string") return false;
  const major = selectorPattern.exec(value)?.[1];
  return (
    major !== undefined &&
    major === policy.slice(0, -2) &&
    validRange(value) !== null
  );
};

/** Engines must support every stable release in the approved major series. */
export const nodeSupportRangeMatches = (policy: string, range: string) => {
  if (!nodePolicyValid(policy)) return false;
  try {
    return subset(policy, range);
  } catch {
    return false;
  }
};
