import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import type { ExpiryEnforcement } from "./quarantine-policy-core";

type Environment = Readonly<Record<string, string | undefined>>;

const scopedEvents = new Set([
  "pull_request",
  "pull_request_target",
  "merge_group",
]);
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unavailable = (reason: string): ExpiryEnforcement => ({
  kind: "changed",
  base: { unavailable: reason },
});

const eventBase = (event: string, eventPath: string | undefined) => {
  if (eventPath === undefined || eventPath === "") return undefined;
  const payload: unknown = JSON.parse(readFileSync(eventPath, "utf8"));
  if (!record(payload)) return undefined;
  let sha: unknown;
  if (event === "merge_group") {
    const group = payload["merge_group"];
    sha = record(group) ? group["base_sha"] : undefined;
  } else {
    const pullRequest = payload["pull_request"];
    const base = record(pullRequest) ? pullRequest["base"] : undefined;
    sha = record(base) ? base["sha"] : undefined;
  }
  return typeof sha === "string" && COMMIT.test(sha) ? sha : undefined;
};

/**
 * Derive expiry enforcement from the run context. Default-branch pushes,
 * schedules, dispatches and other CI fail every overdue exclude; pull requests
 * and merge groups fail only excludes the change adds or edits; local runs warn.
 */
export const resolveExpiryEnforcement = (
  root: string,
  env: Environment = process.env,
): ExpiryEnforcement => {
  if (env["GITHUB_ACTIONS"] !== "true") {
    const ci = env["CI"];
    return ci === undefined || ci === "" || ci === "false" || ci === "0"
      ? { kind: "advisory" }
      : { kind: "enforce" };
  }
  const event = env["GITHUB_EVENT_NAME"];
  if (event === undefined || !scopedEvents.has(event))
    return { kind: "enforce" };
  let sha: string | undefined;
  try {
    sha = eventBase(event, env["GITHUB_EVENT_PATH"]);
  } catch {
    sha = undefined;
  }
  if (sha === undefined)
    return unavailable(`the ${event} event payload has no base commit`);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    return unavailable(
      `base commit ${sha} is not in the local clone; check out with full history (actions/checkout fetch-depth: 0)`,
    );
  }
  try {
    git(["cat-file", "-e", `${sha}:./bunfig.toml`]);
  } catch {
    // No bunfig.toml at the base: every current entry is new.
    return { kind: "changed", base: { bunfig: undefined } };
  }
  try {
    return {
      kind: "changed",
      base: { bunfig: git(["show", `${sha}:./bunfig.toml`]) },
    };
  } catch {
    return unavailable(`cannot read bunfig.toml at base commit ${sha}`);
  }
};
