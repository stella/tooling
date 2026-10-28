import { type ExpiryScope, overdueVerdict } from "./dated-entry-scope";

export type RustInstallFixture = {
  path: string;
  pin: string;
  reason: string;
  tracking: string;
  expires: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const date = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

/** Historical install probes do not authorize using an older compiler. */
export const parseRustInstallFixtures = (
  input: unknown,
): RustInstallFixture[] => {
  if (input === undefined) return [];
  if (!Array.isArray(input))
    throw new Error("rustInstallFixtures must be an array");
  const identities = new Set<string>();
  return input.map((entry: unknown) => {
    if (
      !record(entry) ||
      Object.keys(entry).length !== 5 ||
      Object.keys(entry).some(
        (key) =>
          !["path", "pin", "reason", "tracking", "expires"].includes(key),
      ) ||
      typeof entry["path"] !== "string" ||
      !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.sh$/.test(entry["path"]) ||
      typeof entry["pin"] !== "string" ||
      !(
        /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(entry["pin"]) ||
        (entry["pin"].startsWith("nightly-") && date(entry["pin"].slice(8)))
      ) ||
      typeof entry["reason"] !== "string" ||
      entry["reason"].trim() === "" ||
      typeof entry["tracking"] !== "string" ||
      !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/[1-9]\d*$/.test(
        entry["tracking"],
      ) ||
      typeof entry["expires"] !== "string" ||
      !date(entry["expires"])
    )
      throw new Error(
        "each Rust install fixture requires an exact shell path, stable or dated nightly pin, reason, GitHub tracking URL and valid expiry date",
      );
    const identity = `${entry["path"]}:${entry["pin"]}`;
    if (identities.has(identity))
      throw new Error("Rust install fixture path/pin pairs must be unique");
    identities.add(identity);
    return {
      path: entry["path"],
      pin: entry["pin"],
      reason: entry["reason"],
      tracking: entry["tracking"],
      expires: entry["expires"],
    };
  });
};

type RustInstallFixtureExpiryOptions = {
  fixtures: readonly RustInstallFixture[];
  scope: ExpiryScope;
  now?: Date | undefined;
};

export const checkRustInstallFixtureExpiry = ({
  fixtures,
  scope,
  now = new Date(),
}: RustInstallFixtureExpiryOptions) => {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const fixture of fixtures) {
    if (fixture.expires > now.toISOString().slice(0, 10)) continue;
    const verdict = overdueVerdict(scope, "stll-toolchain.json", (text) => {
      const base: unknown = JSON.parse(text);
      const declarations = record(base)
        ? base["rustInstallFixtures"]
        : undefined;
      return (
        Array.isArray(declarations) &&
        declarations.some(
          (entry: unknown) =>
            record(entry) &&
            entry["path"] === fixture.path &&
            entry["pin"] === fixture.pin &&
            entry["expires"] === fixture.expires,
        )
      );
    });
    const message = `Rust install fixture ${fixture.path}:${fixture.pin} expired on ${fixture.expires}; remove it or renew the documented fixture boundary`;
    if (!verdict.fail) warnings.push(message);
    else
      errors.push(
        verdict.unavailable === undefined
          ? message
          : `${message}; cannot determine whether this change adds it: ${verdict.unavailable}`,
      );
  }
  return { errors, warnings };
};
