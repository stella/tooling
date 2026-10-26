import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const quarantineCli = fileURLToPath(
  new URL("./quarantine-cli.ts", import.meta.url),
);
const toolchainCli = fileURLToPath(
  new URL("./toolchain-check-cli.ts", import.meta.url),
);
const directories: string[] = [];
afterAll(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
});

const EXPIRED = '"fast-uri", # quarantine-expires: 2020-01-01T00:00:00.000Z';
const FUTURE = '"zod", # quarantine-expires: 2099-01-01T00:00:00.000Z';
const MISSING_SHA = "0123456789abcdef0123456789abcdef01234567";
const bunfig = (...temporary: string[]) =>
  `[install]\nminimumReleaseAge = 432000\nminimumReleaseAgeExcludes = [\n  "@stll/oxlint-config",\n${temporary.map((entry) => `  ${entry}\n`).join("")}]\n`;
const rustException = (expires: string) =>
  JSON.stringify({
    rustExceptions: [
      {
        pin: "1.97.1",
        reason: "Awaiting upstream compiler support",
        tracking: "https://github.com/stella/tooling/issues/123",
        expires,
      },
    ],
  });

type Files = Record<string, string | undefined>;
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * A real repository with a base commit and a change commit on top of it.
 * `shallow` checks the change out as a depth-1 clone whose remote has the base,
 * as actions/checkout does by default.
 */
const repository = (
  base: Files,
  head: Files,
  { shallow = false }: { shallow?: boolean } = {},
) => {
  const directory = mkdtempSync(join(tmpdir(), "stll-dated-entry-scope-"));
  directories.push(directory);
  const origin = join(directory, "origin");
  execFileSync("git", ["init", "-q", origin]);
  git(origin, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
  const commit = (files: Files) => {
    for (const [file, text] of Object.entries(files)) {
      if (text === undefined) rmSync(join(origin, file), { force: true });
      else writeFileSync(join(origin, file), text);
    }
    git(origin, ["add", "-A", "."]);
    git(origin, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ]);
    return git(origin, ["rev-parse", "HEAD"]);
  };
  const baseSha = commit({
    "package.json": JSON.stringify({
      devDependencies: { "@stll/oxlint-config": "1.4.0" },
    }),
    ...base,
  });
  commit({ "README.md": "unrelated change\n", ...head });
  let root = origin;
  if (shallow) {
    root = join(directory, "clone");
    execFileSync("git", ["clone", "-q", "--depth=1", `file://${origin}`, root]);
  }
  const event = (name: string, payload?: unknown) => {
    const path = join(directory, `${name}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        payload ??
          (name === "merge_group"
            ? { merge_group: { base_sha: baseSha } }
            : { pull_request: { base: { sha: baseSha } } }),
      ),
    );
    return {
      GITHUB_ACTIONS: "true",
      CI: "true",
      GITHUB_EVENT_NAME: name,
      GITHUB_EVENT_PATH: path,
    };
  };
  return { root, baseSha, event };
};

// The runner's own GitHub context must never leak into fixture runs.
const run = (
  cli: string,
  root: string,
  context: Record<string, string>,
  args: string[] = [],
) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      ...context,
    },
  });
const check = (root: string, context: Record<string, string>) =>
  run(quarantineCli, root, context, ["--check"]);
const toolchainLines = (
  root: string,
  context: Record<string, string>,
  rule: string,
) =>
  run(toolchainCli, root, context)
    .stderr.split("\n")
    .filter((line) => line.includes(`[${rule}]`));

test("an expired exclude the pull request does not touch only warns", () => {
  const { root, event } = repository(
    { "bunfig.toml": bunfig(EXPIRED) },
    { "bunfig.toml": bunfig(EXPIRED) },
  );
  for (const name of ["pull_request", "merge_group"]) {
    const result = check(root, event(name));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'warning: bunfig.toml temporary quarantine exclude "fast-uri" expired',
    );
  }
}, 120_000);

test("an expired exclude fails on push, schedule, dispatch and non-GitHub CI", () => {
  const { root, event } = repository(
    { "bunfig.toml": bunfig(EXPIRED) },
    { "bunfig.toml": bunfig(EXPIRED) },
  );
  for (const context of [
    event("push", {}),
    event("schedule", {}),
    event("workflow_dispatch", {}),
    { CI: "true" },
  ]) {
    const result = check(root, context);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'quarantine exclude "fast-uri" expired at 2020-01-01T00:00:00.000Z and is still present',
    );
  }
}, 120_000);

test("local runs outside CI warn about an expired exclude", () => {
  const { root } = repository(
    { "bunfig.toml": bunfig(EXPIRED) },
    { "bunfig.toml": bunfig(EXPIRED) },
  );
  const result = check(root, {});
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("warning:");
}, 120_000);

test("a pull request that adds or edits an expired exclude fails", () => {
  for (const [base, head] of [
    [bunfig(), bunfig(EXPIRED)],
    [undefined, bunfig(EXPIRED)],
    [
      bunfig(EXPIRED),
      bunfig('"fast-uri", # quarantine-expires: 2020-06-01T00:00:00.000Z'),
    ],
  ] as const) {
    const { root, event } = repository(
      { "bunfig.toml": base },
      { "bunfig.toml": head },
    );
    for (const name of ["pull_request", "merge_group"]) {
      const result = check(root, event(name));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('exclude "fast-uri" expired at');
      expect(result.stderr).toContain("is still present");
    }
  }
}, 120_000);

test("a pull request adding a different exclude does not inherit an expired one", () => {
  const { root, event } = repository(
    { "bunfig.toml": bunfig(EXPIRED) },
    { "bunfig.toml": bunfig(EXPIRED, FUTURE) },
  );
  const result = check(root, event("pull_request"));
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('"fast-uri" expired');
}, 120_000);

test("a shallow checkout fetches exactly the base commit from its remote", () => {
  const unchanged = repository(
    { "bunfig.toml": bunfig(EXPIRED) },
    { "bunfig.toml": bunfig(EXPIRED) },
    { shallow: true },
  );
  expect(() =>
    git(unchanged.root, ["cat-file", "-e", `${unchanged.baseSha}^{commit}`]),
  ).toThrow();
  const warned = check(unchanged.root, unchanged.event("pull_request"));
  expect(warned.status, warned.stderr).toBe(0);
  expect(warned.stderr).toContain(
    'warning: bunfig.toml temporary quarantine exclude "fast-uri"',
  );
  expect(git(unchanged.root, ["cat-file", "-t", unchanged.baseSha])).toBe(
    "commit",
  );
  const added = repository(
    { "bunfig.toml": bunfig() },
    { "bunfig.toml": bunfig(EXPIRED) },
    { shallow: true },
  );
  const failed = check(added.root, added.event("merge_group"));
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain('"fast-uri" expired at');
  expect(failed.stderr).not.toContain("cannot tell");
}, 120_000);

test("an unreachable base fails closed only when an overdue entry needs it", () => {
  const overdue = repository(
    { "bunfig.toml": bunfig(EXPIRED) },
    { "bunfig.toml": bunfig(EXPIRED) },
    { shallow: true },
  );
  const missing = check(
    overdue.root,
    overdue.event("pull_request", {
      pull_request: { base: { sha: MISSING_SHA } },
    }),
  );
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("cannot tell whether this change adds it");
  expect(missing.stderr).toContain(
    `"git fetch --no-tags --depth=1 origin ${MISSING_SHA}" failed`,
  );
  expect(missing.stderr).toContain("fetch-depth: 0");
  const malformed = check(
    overdue.root,
    overdue.event("merge_group", { merge_group: {} }),
  );
  expect(malformed.status).toBe(1);
  expect(malformed.stderr).toContain("has no readable base commit");
  // A temporary entry that has not expired needs no base at all.
  const current = repository(
    { "bunfig.toml": bunfig(FUTURE) },
    { "bunfig.toml": bunfig(FUTURE) },
    { shallow: true },
  );
  const clean = check(
    current.root,
    current.event("pull_request", {
      pull_request: { base: { sha: MISSING_SHA } },
    }),
  );
  expect(clean.status, clean.stderr).toBe(0);
}, 120_000);

test("stll-toolchain-check applies the same scope to quarantine excludes", () => {
  const { root, event } = repository(
    { "bunfig.toml": bunfig(EXPIRED) },
    { "bunfig.toml": bunfig(EXPIRED) },
  );
  const pullRequest = toolchainLines(
    root,
    event("pull_request"),
    "quarantine-policy",
  );
  expect(pullRequest).toHaveLength(1);
  expect(pullRequest.at(0)).toContain("[quarantine-policy] warning:");
  const push = toolchainLines(root, event("push", {}), "quarantine-policy");
  expect(push).toHaveLength(1);
  expect(push.at(0)).not.toContain("warning:");
  expect(push.at(0)).toContain('"fast-uri" expired');
}, 120_000);

test("expired Rust exceptions follow the same scope", () => {
  const expiredLines = (root: string, context: Record<string, string>) =>
    toolchainLines(root, context, "configuration").filter((line) =>
      line.includes("Rust exception 1.97.1 expired on 2020-01-01"),
    );
  const untouched = repository(
    {
      "bunfig.toml": bunfig(),
      "stll-toolchain.json": rustException("2020-01-01"),
    },
    {
      "bunfig.toml": bunfig(),
      "stll-toolchain.json": rustException("2020-01-01"),
    },
    { shallow: true },
  );
  for (const name of ["pull_request", "merge_group"]) {
    const lines = expiredLines(untouched.root, untouched.event(name));
    expect(lines).toHaveLength(1);
    expect(lines.at(0)).toContain("[configuration] warning:");
  }
  const local = expiredLines(untouched.root, {});
  expect(local).toHaveLength(1);
  expect(local.at(0)).toContain("warning:");
  for (const context of [untouched.event("push", {}), { CI: "true" }]) {
    const lines = expiredLines(untouched.root, context);
    expect(lines).toHaveLength(1);
    expect(lines.at(0)).not.toContain("warning:");
  }
  for (const base of [rustException("2099-01-01"), undefined]) {
    const changed = repository(
      { "bunfig.toml": bunfig(), "stll-toolchain.json": base },
      {
        "bunfig.toml": bunfig(),
        "stll-toolchain.json": rustException("2020-01-01"),
      },
    );
    const lines = expiredLines(changed.root, changed.event("pull_request"));
    expect(lines).toHaveLength(1);
    expect(lines.at(0)).not.toContain("warning:");
  }
}, 120_000);
