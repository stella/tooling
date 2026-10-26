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
const bunfig = (...temporary: string[]) =>
  `[install]\nminimumReleaseAge = 432000\nminimumReleaseAgeExcludes = [\n  "@stll/oxlint-config",\n${temporary.map((entry) => `  ${entry}\n`).join("")}]\n`;

/** A real repository with a base commit and a change commit on top of it. */
const repository = (base: string | undefined, head: string) => {
  const directory = mkdtempSync(join(tmpdir(), "stll-expiry-scope-"));
  directories.push(directory);
  const root = join(directory, "repo");
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  execFileSync("git", ["init", "-q", root]);
  const commit = () => {
    git(["add", "."]);
    git([
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
    return git(["rev-parse", "HEAD"]);
  };
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ devDependencies: { "@stll/oxlint-config": "1.4.0" } }),
  );
  if (base !== undefined) writeFileSync(join(root, "bunfig.toml"), base);
  const baseSha = commit();
  writeFileSync(join(root, "README.md"), "unrelated change\n");
  writeFileSync(join(root, "bunfig.toml"), head);
  commit();
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
  return { root, event };
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

test("an expired exclude the pull request does not touch only warns", () => {
  const { root, event } = repository(bunfig(EXPIRED), bunfig(EXPIRED));
  for (const name of ["pull_request", "merge_group"]) {
    const result = check(root, event(name));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'warning: bunfig.toml temporary quarantine exclude "fast-uri" expired',
    );
  }
}, 30_000);

test("an expired exclude fails on push, schedule, dispatch and non-GitHub CI", () => {
  const { root, event } = repository(bunfig(EXPIRED), bunfig(EXPIRED));
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
}, 30_000);

test("local runs outside CI warn about an expired exclude", () => {
  const { root } = repository(bunfig(EXPIRED), bunfig(EXPIRED));
  const result = check(root, {});
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("warning:");
}, 30_000);

test("a pull request that adds or edits an expired exclude fails", () => {
  for (const [base, head] of [
    [bunfig(), bunfig(EXPIRED)],
    [undefined, bunfig(EXPIRED)],
    [
      bunfig(EXPIRED),
      bunfig('"fast-uri", # quarantine-expires: 2020-06-01T00:00:00.000Z'),
    ],
  ] as const) {
    const { root, event } = repository(base, head);
    for (const name of ["pull_request", "merge_group"]) {
      const result = check(root, event(name));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('exclude "fast-uri" expired at');
      expect(result.stderr).toContain("is still present");
    }
  }
}, 30_000);

test("a pull request adding a different exclude does not inherit an expired one", () => {
  const { root, event } = repository(
    bunfig(EXPIRED),
    bunfig(EXPIRED, '"zod", # quarantine-expires: 2099-01-01T00:00:00.000Z'),
  );
  const result = check(root, event("pull_request"));
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('"fast-uri" expired');
}, 30_000);

test("pull request scope fails closed when the base revision is unavailable", () => {
  const { root, event } = repository(bunfig(EXPIRED), bunfig(EXPIRED));
  const missing = check(
    root,
    event("pull_request", {
      pull_request: {
        base: { sha: "0123456789abcdef0123456789abcdef01234567" },
      },
    }),
  );
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain(
    "need the base revision to scope expiry checks",
  );
  expect(missing.stderr).toContain("fetch-depth: 0");
  const malformed = check(root, event("merge_group", { merge_group: {} }));
  expect(malformed.status).toBe(1);
  expect(malformed.stderr).toContain("event payload has no base commit");
  // Without temporary excludes there is nothing to scope, so no history is needed.
  const permanentOnly = repository(bunfig(), bunfig());
  const clean = check(
    permanentOnly.root,
    permanentOnly.event("pull_request", {
      pull_request: {
        base: { sha: "0123456789abcdef0123456789abcdef01234567" },
      },
    }),
  );
  expect(clean.status, clean.stderr).toBe(0);
}, 30_000);

test("stll-toolchain-check applies the same scope to the quarantine rule", () => {
  const { root, event } = repository(bunfig(EXPIRED), bunfig(EXPIRED));
  const quarantineLines = (context: Record<string, string>) =>
    run(toolchainCli, root, context)
      .stderr.split("\n")
      .filter((line) => line.includes("[quarantine-policy]"));
  const pullRequest = quarantineLines(event("pull_request"));
  expect(pullRequest).toHaveLength(1);
  expect(pullRequest.at(0)).toContain("[quarantine-policy] warning:");
  const push = quarantineLines(event("push", {}));
  expect(push).toHaveLength(1);
  expect(push.at(0)).not.toContain("warning:");
  expect(push.at(0)).toContain('"fast-uri" expired');
}, 60_000);
