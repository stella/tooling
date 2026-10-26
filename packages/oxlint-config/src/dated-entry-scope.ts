import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** A tracked file at the base revision: absent (`text: undefined`) or unreadable. */
export type BaseFile = { text: string | undefined } | { unavailable: string };

/**
 * Which overdue dated entries (quarantine excludes, Rust exceptions) fail. The
 * clock alone never fails a change that leaves an entry untouched: `enforce`
 * fails every overdue entry (default branch, schedule), `advisory` only warns
 * (local runs), and `changed` fails entries absent or different at the base.
 */
export type ExpiryScope =
  | { kind: "enforce" }
  | { kind: "advisory" }
  | { kind: "changed"; readBase: (path: string) => BaseFile };

export type OverdueVerdict =
  { fail: false } | { fail: true; unavailable?: string };

/**
 * Decide one overdue entry. `unchangedAt` reports whether the base file text
 * declares the same entry identically; a base that cannot prove that fails.
 * The base is read only here, so runs without overdue entries never need it.
 */
export const overdueVerdict = (
  scope: ExpiryScope,
  path: string,
  unchangedAt: (baseText: string) => boolean,
): OverdueVerdict => {
  if (scope.kind === "enforce") return { fail: true };
  if (scope.kind === "advisory") return { fail: false };
  const base = scope.readBase(path);
  if ("unavailable" in base)
    return { fail: true, unavailable: base.unavailable };
  if (base.text === undefined) return { fail: true };
  try {
    return unchangedAt(base.text) ? { fail: false } : { fail: true };
  } catch {
    return { fail: true };
  }
};

type Environment = Readonly<Record<string, string | undefined>>;

const scopedEvents = new Set([
  "pull_request",
  "pull_request_target",
  "merge_group",
]);
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
 * Derive the expiry scope from the run context. Pushes, schedules, dispatches,
 * other GitHub events and non-GitHub CI enforce; pull requests and merge groups
 * compare with the event's base commit, fetching only that commit when a
 * shallow checkout lacks it; local runs are advisory.
 */
export const resolveExpiryScope = (
  root: string,
  env: Environment = process.env,
): ExpiryScope => {
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
  if (sha === undefined) {
    const unavailable = `the ${event} event payload (GITHUB_EVENT_PATH) has no readable base commit`;
    return { kind: "changed", readBase: () => ({ unavailable }) };
  }
  const base = sha;
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
  const succeeds = (args: string[]) => {
    try {
      git(args);
      return true;
    } catch {
      return false;
    }
  };
  const hasCommit = () => succeeds(["cat-file", "-e", `${base}^{commit}`]);
  let commitProblem: string | null | undefined;
  // Shallow checkouts lack the base; fetch exactly that commit once.
  const ensureCommit = () => {
    if (commitProblem !== undefined) return commitProblem;
    if (hasCommit()) return (commitProblem = null);
    let remotes: string[];
    try {
      remotes = git(["remote"]).split("\n").filter(Boolean);
    } catch {
      remotes = [];
    }
    let remote: string | undefined;
    if (remotes.includes("origin")) remote = "origin";
    else if (remotes.length === 1) remote = remotes.at(0);
    if (remote === undefined)
      return (commitProblem = `base commit ${base} is not in the clone and no single checkout remote can fetch it; check out with actions/checkout`);
    succeeds(["fetch", "--no-tags", "--depth=1", remote, base]);
    commitProblem = hasCommit()
      ? null
      : `base commit ${base} is not in the clone and "git fetch --no-tags --depth=1 ${remote} ${base}" failed; keep the actions/checkout credentials (persist-credentials: true) or check out with fetch-depth: 0`;
    return commitProblem;
  };
  const files = new Map<string, BaseFile>();
  const read = (path: string): BaseFile => {
    const problem = ensureCommit();
    if (problem !== null) return { unavailable: problem };
    if (!succeeds(["cat-file", "-e", `${base}:./${path}`]))
      return { text: undefined };
    try {
      return { text: git(["show", `${base}:./${path}`]) };
    } catch {
      return { unavailable: `cannot read ${path} at base commit ${base}` };
    }
  };
  return {
    kind: "changed",
    readBase: (path) => {
      const cached = files.get(path) ?? read(path);
      files.set(path, cached);
      return cached;
    },
  };
};
