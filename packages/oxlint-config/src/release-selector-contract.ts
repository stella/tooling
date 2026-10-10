import { parse } from "yaml";

const selectorActionNames = [
  "actions/setup-node",
  "oven-sh/setup-bun",
  "actions/setup-python",
] as const;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Derive the immutable shared checkout from the existing workflow consumer. */
export const releasePolicyRef = (source: string) => {
  const workflow: unknown = parse(source);
  const jobs = record(workflow) ? workflow["jobs"] : undefined;
  const enforce = record(jobs) ? jobs["enforce"] : undefined;
  const uses = record(enforce) ? enforce["uses"] : undefined;
  const match =
    typeof uses === "string"
      ? uses.match(
          /^stella\/\.github\/\.github\/workflows\/release-policy\.yml@([a-f0-9]{40})$/,
        )
      : null;
  const ref = match?.[1];
  if (ref === undefined)
    throw new Error(
      "release-policy jobs.enforce.uses must pin the shared workflow at a full SHA",
    );
  return ref;
};

type ValidateSelectorContractOptions = {
  selectors: unknown;
  actions: Record<string, { sha: string }>;
};

/** Bind the shared action capability registry to the installed toolchain pins. */
export const validateSelectorContract = ({
  selectors,
  actions,
}: ValidateSelectorContractOptions) => {
  if (!(selectors instanceof Set))
    throw new Error(
      "shared release policy must export FILE_SELECTOR_ACTIONS as a string Set",
    );
  const selected = Array.from(selectors, (value: unknown) => value);
  if (!selected.every((value) => typeof value === "string"))
    throw new Error(
      "shared release policy must export FILE_SELECTOR_ACTIONS as a string Set",
    );
  const expected = new Set(
    selectorActionNames.map((name) => {
      const sha = actions[name]?.sha;
      if (sha === undefined || !/^[a-f0-9]{40}$/.test(sha))
        throw new Error(`toolchain action ${name} must have a full SHA`);
      return `${name}@${sha}`;
    }),
  );
  const missing = [...expected].filter((value) => !selectors.has(value));
  const extra = selected.filter((value) => !expected.has(value));
  if (missing.length === 0 && extra.length === 0) return;
  throw new Error(
    `runtime selector action pins differ: missing [${missing.join(", ")}]; extra [${extra.join(", ")}]`,
  );
};
