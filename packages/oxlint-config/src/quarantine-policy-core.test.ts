import { describe, expect, test } from "bun:test";
import { parse as parseToml } from "smol-toml";

import {
  checkQuarantinePolicy,
  exactTimestamp,
  isFirstPartyPackageName,
  pruneExpiredExcludes,
  readParsedExcludes,
  readRegistryFirstPartyPackages,
  REQUIRED_RELEASE_AGE_SECONDS,
  synchronizeFirstPartyExcludes,
} from "./quarantine-policy-core.ts";

const now = new Date("2026-10-17T12:00:00.000Z");
const expires = "2026-10-19T12:00:00.000Z";
const since = "2026-09-01T00:00:00.000Z";
const fixture = (entries = "") =>
  `[install]\nminimumReleaseAge = ${REQUIRED_RELEASE_AGE_SECONDS}\nminimumReleaseAgeExcludes = [\n${entries}\n]\n`;
const check = (
  bunfig: string,
  options: {
    now?: Date;
    npmrcPresent?: boolean;
    lockfile?: string;
    firstPartyPackages?: ReadonlySet<string>;
  } = {},
) =>
  checkQuarantinePolicy({
    bunfig,
    lockfile: '{"packages": {}}',
    parseToml,
    now,
    ...options,
  });
const prune = (bunfig: string) =>
  pruneExpiredExcludes({ bunfig, now, parseToml });
const sync = (bunfig: string, names: readonly string[], date = now) =>
  synchronizeFirstPartyExcludes({
    bunfig,
    firstPartyPackages: names,
    parseToml,
    now: date,
  });

const parsers = {
  "smol-toml": parseToml,
  "Bun.TOML": (source: string): unknown => Bun.TOML.parse(source),
};
for (const [parserName, parser] of Object.entries(parsers)) {
  describe(parserName, () => {
    test("binds source annotations to the parsed install array", () => {
      const bunfig = `# minimumReleaseAgeExcludes = ["fake"]\nnote = '''\n[install]\nminimumReleaseAgeExcludes = ["also-fake"]\n'''\n[other]\nminimumReleaseAgeExcludes = ["not-the-policy"]\n${fixture(`  # comments may contain ] and [\n  '@stll/own',\n  "third-party", # quarantine-expires: ${expires}`)}`;
      expect(
        checkQuarantinePolicy({
          bunfig,
          lockfile: '{"packages": {}}',
          parseToml: parser,
          now,
        }),
      ).toEqual({
        errors: [],
        warnings: [expect.stringContaining("expires at")],
      });
      expect(readParsedExcludes(bunfig, parser)).toEqual([
        "@stll/own",
        "third-party",
      ]);
    });

    test("understands one-line arrays, quoted keys and dotted declarations", () => {
      const bunfig = `["install"]\n"minimumReleaseAge" = ${REQUIRED_RELEASE_AGE_SECONDS}\n"minimumReleaseAgeExcludes" = ["@stll/a", '@stll/b']\n`;
      expect(
        checkQuarantinePolicy({
          bunfig,
          lockfile: '{"packages": {}}',
          parseToml: parser,
          now,
        }).errors,
      ).toEqual([]);
      const dotted = `install.minimumReleaseAge = ${REQUIRED_RELEASE_AGE_SECONDS}\ninstall.minimumReleaseAgeExcludes = ["third"] # quarantine-expires: ${expires}\n`;
      expect(readParsedExcludes(dotted, parser)).toEqual(["third"]);
      expect(
        checkQuarantinePolicy({
          bunfig: dotted,
          lockfile: '{"packages": {}}',
          parseToml: parser,
          now,
        }).errors,
      ).toEqual([]);
    });

    test("decodes escaped TOML package names before comparing source and manifest", () => {
      const bunfig = fixture('  "@stll/\\u0061",');
      expect(readParsedExcludes(bunfig, parser)).toEqual(["@stll/a"]);
      expect(
        checkQuarantinePolicy({
          bunfig,
          lockfile: '{"packages": {}}',
          parseToml: parser,
          now,
        }).errors,
      ).toEqual([]);
    });

    test("rejects duplicate TOML declarations before any source edits", () => {
      const bunfig = fixture() + "minimumReleaseAgeExcludes = []\n";
      expect(() => readParsedExcludes(bunfig, parser)).toThrow(
        /duplicate|redefine|already/iu,
      );
      expect(() =>
        pruneExpiredExcludes({ bunfig, now, parseToml: parser }),
      ).toThrow(/duplicate|redefine|already/iu);
    });
  });
}

test.each([
  "@stll/*",
  "@stll/x@1.0.0",
  "thing@1.0.0",
  "file:thing",
  "npm:thing",
  "../thing",
  "@stll/a/b",
  "thing*",
  "@stll/",
  "a b",
  "Thing",
])("rejects nonexact npm entry %s", (name) => {
  expect(check(fixture(`  ${JSON.stringify(name)},`)).errors).toEqual([
    expect.stringContaining("exact npm package names"),
  ]);
});

test.each([
  "2026-10-17T12:00:00Z",
  "2026-10-17T12:00:00.000+00:00",
  "2026-02-30T00:00:00.000Z",
  "2026-10-17",
  "not-a-date",
])("rejects inexact or invalid UTC timestamp %s", (timestamp) => {
  expect(exactTimestamp(timestamp)).toBe(false);
  expect(
    check(fixture(`  "third", # quarantine-expires: ${timestamp}`)).errors,
  ).toEqual([expect.stringContaining("invalid UTC timestamp")]);
});

test("accepts permanent own names bare or with an exact historical creation timestamp", () => {
  const result = check(
    fixture(
      `  "@stll/bare",\n  "@stll/history", # quarantine-excluded-since: ${since}`,
    ),
  );
  expect(result).toEqual({ errors: [], warnings: [] });
  expect(exactTimestamp(since)).toBe(true);
});

test.each([
  '  "third",',
  '  "third", # quarantine-expires 2026-10-19T12:00:00.000Z',
  '  "third", # quarantine-expires: 2026-10-19T12:00:00.000Z extra',
  '  "third", # unrelated annotation',
  `  "third", # quarantine-excluded-since: ${since}`,
  `  "@stll/own", # quarantine-expires: ${expires}`,
  '  "@stll/own", # quarantine-excluded-since: bad',
  '  "@stll/own", # quarantine-excluded-since: 2027-01-01T00:00:00.000Z',
])("rejects malformed or wrong-kind annotation %s", (entry) => {
  expect(check(fixture(entry)).errors).not.toEqual([]);
});

test.each([
  [-48 * 60 * 60 * 1000 - 1, 0, 0],
  [-48 * 60 * 60 * 1000, 0, 1],
  [-1, 0, 1],
  [0, 0, 1],
  [24 * 60 * 60 * 1000 - 1, 0, 1],
  [24 * 60 * 60 * 1000, 1, 0],
])(
  "warns 48 hours before expiry and errors after 24-hour grace (%d ms)",
  (offset, errors, warnings) => {
    const result = check(
      fixture(`  "third", # quarantine-expires: ${expires}`),
      { now: new Date(Date.parse(expires) + offset) },
    );
    expect(result.errors).toHaveLength(errors);
    expect(result.warnings).toHaveLength(warnings);
  },
);

test("requires every supplied own name and derives fallback only from lock packages", () => {
  const lockfile = `{
    // Registry own identity outside packages is not a dependency.
    "metadata": { "fake": ["@stll/not-a-package@1.0.0"] },
    "packages": {
      "alias": ["@stll/real@1.2.3", "", {}, "integrity"],
      "workspace": ["@stll/local@workspace:packages/local"],
      "git": ["@stll/git@github:stella/git"],
      "file": ["@stll/file@file:../file"],
      "third": ["third@1.0.0"],
    },
  }`;
  expect([...readRegistryFirstPartyPackages(lockfile)]).toEqual(["@stll/real"]);
  expect(check(fixture(), { lockfile }).errors).toEqual([
    expect.stringContaining("@stll/real"),
  ]);
  expect(check(fixture('  "@stll/real",'), { lockfile }).errors).toEqual([]);
  expect(
    check(fixture(), { firstPartyPackages: new Set(["@stll/direct"]) }).errors,
  ).toEqual([expect.stringContaining("@stll/direct")]);
  expect(
    check(fixture(), { firstPartyPackages: new Set(["third"]) }).errors,
  ).toEqual([expect.stringContaining("exact first-party")]);
  expect(check(fixture(), { lockfile: "not JSONC" }).errors).not.toEqual([]);
});

test.each([
  "[install]\nminimumReleaseAge = 1\nminimumReleaseAgeExcludes = []\n",
  `[install]\nminimumReleaseAge = ${REQUIRED_RELEASE_AGE_SECONDS}\nminimumReleaseAgeExcludes = [true]\n`,
  `[install]\nminimumReleaseAge = ${REQUIRED_RELEASE_AGE_SECONDS}\nminimumReleaseAgeExcludes = ["@stll/a", "@stll/a"]\n`,
  `registry = "https://elsewhere.test"\n`,
  `[install]\nminimumReleaseAge = ${REQUIRED_RELEASE_AGE_SECONDS}\nminimumReleaseAgeExcludes = []\nregistry = "https://elsewhere.test"\n`,
  fixture() + '[install.scopes]\nprivate = "https://elsewhere.test"\n',
])("fails closed on invalid policy %s", (bunfig) => {
  expect(check(bunfig).errors).not.toEqual([]);
});

test("rejects npmrc presence and invalid current dates", () => {
  expect(check(fixture(), { npmrcPresent: true }).errors).toEqual([
    expect.stringContaining(".npmrc"),
  ]);
  expect(check(fixture(), { now: new Date(Number.NaN) }).errors).toEqual([
    expect.stringContaining("valid current date"),
  ]);
});

test("prunes only expired third-party entries and is a fixed point", () => {
  const bunfig =
    fixture(
      `  "@stll/legacy", # quarantine-expires: 2020-01-01T00:00:00.000Z\n  "@stll/permanent", # quarantine-excluded-since: ${since}\n  "expired", # quarantine-expires: 2026-10-17T12:00:00.000Z\n  "future", # quarantine-expires: ${expires}`,
    ) + '[unrelated]\nvalue = "] # untouched"\n';
  const result = prune(bunfig);
  expect(result.pruned).toEqual(["expired"]);
  expect(readParsedExcludes(result.bunfig, parseToml)).toEqual([
    "@stll/legacy",
    "@stll/permanent",
    "future",
  ]);
  expect(result.bunfig).toContain('value = "] # untouched"');
  expect(prune(result.bunfig)).toEqual({ bunfig: result.bunfig, pruned: [] });
  expect(
    prune(
      bunfig.replace("2026-10-17T12:00:00.000Z", "2026-10-17T12:00:00.001Z"),
    ).pruned,
  ).toEqual([]);
});

test("prunes a single-line array without removing its closing bracket", () => {
  const bunfig = `[install]\nminimumReleaseAge = ${REQUIRED_RELEASE_AGE_SECONDS}\nminimumReleaseAgeExcludes = ["expired"] # quarantine-expires: ${since}\n`;
  const result = prune(bunfig);
  expect(result.pruned).toEqual(["expired"]);
  expect(readParsedExcludes(result.bunfig, parseToml)).toEqual([]);
});

test("sync owns exact first-party set, preserves temporary entries and unrelated TOML, and is a fixed point", () => {
  const suffix = '\n[unrelated]\nmessage = "[ # ]"\n';
  const bunfig =
    fixture(
      `  # temporary policy stays in this array\n  "third", # quarantine-expires: ${expires}\n  "@stll/old",\n  "@stll/history", # quarantine-excluded-since: ${since}\n  "@stll/legacy", # quarantine-expires: 2020-01-01T00:00:00.000Z`,
    ) + suffix;
  const names = ["@stll/history", "@stll/legacy", "@stll/new"];
  const result = sync(bunfig, names);
  expect(readParsedExcludes(result, parseToml)).toEqual(["third", ...names]);
  expect(result).toContain(
    `"@stll/history", # quarantine-excluded-since: ${since}`,
  );
  expect(result).toContain(
    `"@stll/legacy", # quarantine-excluded-since: ${now.toISOString()}`,
  );
  expect(result).toContain(`"third", # quarantine-expires: ${expires}`);
  expect(result).toEndWith(suffix);
  expect(result).toContain("# temporary policy stays in this array");
  expect(sync(result, names, new Date("2026-11-01T00:00:00.000Z"))).toBe(
    result,
  );
  expect(check(result, { firstPartyPackages: new Set(names) }).errors).toEqual(
    [],
  );
});

test("sync renders one-line bare own names permanently and preserves CRLF", () => {
  const bunfig = `[install]\r\nminimumReleaseAge = ${REQUIRED_RELEASE_AGE_SECONDS}\r\nminimumReleaseAgeExcludes = ["@stll/a", "@stll/b"]\r\n`;
  const result = sync(bunfig, ["@stll/a", "@stll/b"]);
  expect(result).toContain(
    `"@stll/a", # quarantine-excluded-since: ${now.toISOString()}`,
  );
  expect(result).not.toMatch(/(?<!\r)\n/u);
  expect(sync(result, ["@stll/a", "@stll/b"])).toBe(result);
});

test("first-party identity validation rejects wildcard, version and alias inputs", () => {
  expect(isFirstPartyPackageName("@stll/oxlint-config")).toBe(true);
  for (const name of [
    "@stll/*",
    "@stll/a@1.0.0",
    "@stll/a/b",
    "npm:@stll/a",
    "third",
  ])
    expect(isFirstPartyPackageName(name)).toBe(false);
});

test("mutations reject malformed temporary annotations without removing unrelated entries", () => {
  const bunfig = fixture('  "third", # quarantine-expires: not-a-date');
  expect(() => prune(bunfig)).toThrow("exact UTC quarantine-expires:");
  expect(() => sync(bunfig, ["@stll/a"])).toThrow(
    "exact UTC quarantine-expires:",
  );
});

test("an optional declaration set cannot suppress registry-backed own exclusions", () => {
  const lockfile = '{"packages":{"transitive":["@stll/transitive@1.2.3"]}}';
  const result = check(fixture('  "@stll/direct",'), {
    lockfile,
    firstPartyPackages: new Set(["@stll/direct"]),
  });
  expect(result.errors).toEqual([expect.stringContaining("@stll/transitive")]);
  expect(
    check(fixture(), { lockfile, firstPartyPackages: new Set() }).errors,
  ).toEqual([expect.stringContaining("@stll/transitive")]);
  expect([...readRegistryFirstPartyPackages(undefined)]).toEqual([]);
  expect(
    checkQuarantinePolicy({
      bunfig: fixture(),
      lockfile: undefined,
      parseToml,
      now,
    }).errors,
  ).toEqual([]);
  expect(() => readRegistryFirstPartyPackages("")).toThrow(/JSON/u);
});

test("sync preserves CRLF with temporary and standalone comments", () => {
  const bunfig = fixture(`  # keep this context
  "third", # quarantine-expires: ${expires}
  "@stll/a",`).replaceAll("\n", "\r\n");
  const result = sync(bunfig, ["@stll/a"]);
  expect(readParsedExcludes(result, parseToml)).toEqual(["third", "@stll/a"]);
  expect(result).not.toContain("\r\r");
  expect(sync(result, ["@stll/a"])).toBe(result);
});
