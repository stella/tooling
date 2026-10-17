import {
  decodeShellWord,
  shellTokens,
  shellCommandSegments,
} from "./toolchain-packages";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Split only boolean operators outside parentheses and quoted string literals.
const booleanParts = (source: string, operator: "&&" | "||") => {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "'") {
      if (quoted && source[index + 1] === "'") index++;
      else quoted = !quoted;
    }
    if (quoted) continue;
    if (character === "(") depth++;
    if (character === ")") depth--;
    if (depth === 0 && source.slice(index, index + 2) === operator) {
      parts.push(source.slice(start, index));
      start = index + 2;
      index++;
    }
  }
  parts.push(source.slice(start));
  return parts;
};

const withoutOuterParentheses = (source: string): string => {
  if (!source.startsWith("(") || !source.endsWith(")")) return source;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "'") {
      if (quoted && source[index + 1] === "'") index++;
      else quoted = !quoted;
    }
    if (quoted) continue;
    if (character === "(") depth++;
    if (character === ")") depth--;
    if (depth === 0 && index !== source.length - 1) return source;
  }
  return withoutOuterParentheses(source.slice(1, -1).trim());
};

// A sufficient static proof, not an evaluator for arbitrary Actions expressions.
// Unknown predicates can never authorize repository execution before trust.
type TrustConditionOptions = {
  condition: unknown;
  event: string;
  allowTrust?: boolean;
};
const excludesUntrusted = ({
  condition,
  event,
  allowTrust = true,
}: TrustConditionOptions): boolean => {
  if (condition === false) return true;
  if (typeof condition !== "string") return false;
  const source = withoutOuterParentheses(
    condition
      .trim()
      .replace(/^\$\{\{([\s\S]*)\}\}$/u, "$1")
      .trim(),
  );
  const alternatives = booleanParts(source, "||");
  if (alternatives.length > 1)
    return alternatives.every((part) =>
      excludesUntrusted({ condition: part, event, allowTrust }),
    );
  const conjuncts = booleanParts(source, "&&");
  if (conjuncts.length > 1)
    return conjuncts.some((part) =>
      excludesUntrusted({ condition: part, event, allowTrust }),
    );
  const trustComparison =
    /^needs\.trust-check\.outputs\.trusted\s*==\s*'([^']*)'$/u.exec(source);
  if (allowTrust && trustComparison?.at(1)?.toLowerCase() === "true")
    return true;
  if (source === "false") return true;
  const comparison = /^github\.event_name\s*(==|!=)\s*'([^']+)'$/u.exec(source);
  if (comparison === null) return false;
  // Actions compares string values without regard to case.
  const equal = comparison.at(2)?.toLowerCase() === event.toLowerCase();
  return comparison.at(1) === "==" ? !equal : equal;
};

// This is a deliberately small proof language for pre-trust metadata commands.
// Unknown commands, options, shell constructs, and action inputs require trust.
const staticData = (word: string) =>
  !/[`$\\]/u.test(word) && !/[<>]/u.test(word);
const metadataScript = (command: string) => {
  const interpolation = /\$\{\{([\s\S]*?)\}\}/gu;
  // Actions interpolates before the shell sees quotes or comments. Validate
  // each expression before replacement, without state mutated in a callback.
  for (const match of command.matchAll(interpolation)) {
    const expression = match.at(1);
    if (
      expression === undefined ||
      ![
        "github.sha",
        "github.run_id",
        "github.run_attempt",
        "github.repository",
      ].includes(expression.trim())
    )
      return undefined;
  }
  const source = command.replace(interpolation, "stll-metadata");
  return source.includes("${{") ? undefined : source;
};
const metadataWord = (raw: string) => {
  if (/^'[^']*'$/u.test(raw)) return true;
  if (["[", "]", "[[", "]]"].includes(raw)) return true;
  let quote: "'" | '"' | undefined;
  for (const character of raw) {
    if (quote === undefined && "*?~[{$".includes(character)) return false;
    if (character === quote) quote = undefined;
    else if (quote === undefined && (character === "'" || character === '"'))
      quote = character;
  }
  if (quote !== undefined) return false;
  const withoutKnownExpressions = raw.replace(
    /\$\{[A-Za-z_][A-Za-z_0-9]*\}|\$[A-Za-z_][A-Za-z_0-9]*/gu,
    "value",
  );
  return !/[`$\\]/u.test(withoutKnownExpressions);
};
const safeComparison = (words: readonly string[]) => {
  const first = words.at(0);
  if (!["test", "[", "[["].includes(first ?? "")) return false;
  let end: string | undefined;
  if (first === "[[") end = "]]";
  else if (first === "[") end = "]";
  if (end !== undefined && words.at(-1) !== end) return false;
  const operands = words.slice(1, end === undefined ? undefined : -1);
  if (operands.length === 1) return true;
  if (operands.length === 2) return ["-n", "-z"].includes(operands.at(0) ?? "");
  return (
    operands.length === 3 && ["=", "==", "!="].includes(operands.at(1) ?? "")
  );
};

const objectReference = (value: string) =>
  /^(?:HEAD|[a-f0-9]{7,64}|(?:refs\/(?:heads|tags|remotes)\/|origin\/)[A-Za-z0-9][A-Za-z0-9._/-]*)(?:[~^][0-9]*)*$/u.test(
    value,
  ) &&
  !value.includes("..") &&
  !value.includes("//") &&
  !value.endsWith("/");
// History and diff commands may dispatch configured helpers. Only bounded
// revision queries are proved to remain within repository object metadata.
const safeGit = (words: readonly string[]) => {
  const subcommand = words.at(1);
  if (subcommand !== "rev-parse" && subcommand !== "merge-base") return false;
  const references: string[] = [];
  for (const argument of words.slice(2)) {
    if (!staticData(argument)) return false;
    if (!argument.startsWith("-")) {
      references.push(argument);
      continue;
    }
    const allowed =
      subcommand === "rev-parse"
        ? ["--short", "--verify"]
        : ["--all", "--is-ancestor"];
    if (!allowed.includes(argument)) return false;
  }
  const count = subcommand === "rev-parse" ? 1 : 2;
  return references.length === count && references.every(objectReference);
};

const safeGh = (words: readonly string[]) => {
  if (!words.every(staticData)) return false;
  if (words.at(1) === "api") {
    const arguments_ = words.slice(2);
    if (
      ["--method", "-X"].includes(arguments_.at(0) ?? "") &&
      arguments_.at(1) === "GET"
    )
      arguments_.splice(0, 2);
    if (!arguments_.at(0) || arguments_.at(0)?.startsWith("-")) return false;
    for (let index = 1; index < arguments_.length; index++) {
      const argument = arguments_.at(index);
      if (
        (argument === "--method" || argument === "-X") &&
        arguments_.at(index + 1) === "GET"
      )
        index++;
      else if (
        ["--jq", "-q"].includes(argument ?? "") &&
        /^\.[A-Za-z0-9_.[\]" -]*$/u.test(arguments_.at(index + 1) ?? "")
      )
        index++;
      else return false;
    }
    return /^\/?repos\/[A-Za-z0-9_./-]+$/u.test(arguments_.at(0) ?? "");
  }
  return false;
};

const safeCommand = (raw: readonly string[]): boolean => {
  if (raw.length === 0) return true;
  if (!raw.every(metadataWord)) return false;
  const words = raw.map(decodeShellWord);
  const name = words.at(0);
  // A quoted/dynamic executable is never proved to resolve to a known builtin.
  if (raw.at(0) !== name) return false;
  if (name === "if" || name === "elif") return safeComparison(words.slice(1));
  if (["then", "else"].includes(name ?? "")) return safeCommand(raw.slice(1));
  if (name === "fi") return words.length === 1;
  if (["test", "[", "[["].includes(name ?? "")) return safeComparison(words);
  if (["true", "false"].includes(name ?? "")) return words.length === 1;
  if (name === "exit")
    return (
      words.length === 1 ||
      (words.length === 2 && /^[0-9]+$/u.test(words.at(1) ?? ""))
    );
  if (name === "echo") return true;
  if (name === "printf") {
    const format = words.at(1);
    // Data variables may be arguments, never a format or assignment target.
    return (
      format !== undefined &&
      !format.startsWith("-") &&
      /^(?:[^%$`]|%%|%s)*$/u.test(format)
    );
  }
  if (name === "git") return safeGit(words);
  if (name === "gh") return safeGh(words);
  return false;
};

const invokesRepositoryCode = (command: string) => {
  const source = metadataScript(command);
  if (source === undefined) return true;
  // The shared command scanner intentionally omits redirects. Prove their
  // destinations separately; metadata may only write Actions outputs or discard.
  const tokens = shellTokens(source);
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== "redirect") continue;
    const target = tokens.at(index + 1);
    if (
      ![">", ">>"].includes(token.value) ||
      target?.kind !== "word" ||
      !['"$GITHUB_OUTPUT"', '"${GITHUB_OUTPUT}"', "/dev/null"].includes(
        target.value,
      )
    )
      return true;
  }
  const branches: ("condition" | "then" | "else")[] = [];
  for (let words of shellCommandSegments(source, "tokens")) {
    if (!safeCommand(words)) return true;
    while (["then", "else"].includes(words.at(0) ?? "")) {
      const keyword = words.at(0);
      const previous = branches.pop();
      if (keyword === "then" && previous === "condition") branches.push("then");
      else if (keyword === "else" && previous === "then") branches.push("else");
      else return true;
      words = words.slice(1);
    }
    const keyword = words.at(0);
    if (keyword === "if") branches.push("condition");
    if (keyword === "elif") {
      if (branches.pop() !== "then") return true;
      branches.push("condition");
    }
    if (keyword === "fi") {
      const previous = branches.pop();
      if (previous !== "then" && previous !== "else") return true;
    }
  }
  return branches.length !== 0;
};

// These bootstrap actions may run before the repository's trust decision.
// Input keys are explicit: accepting a repository script input would cross it.
const metadataActionInputs = {
  "actions/checkout": [
    "fetch-depth",
    "persist-credentials",
    "ref",
    "repository",
    "path",
    "submodules",
  ],
  "oven-sh/setup-bun": ["bun-version", "bun-version-file", "no-cache"],
  "actions/setup-node": [
    "node-version",
    "node-version-file",
    "check-latest",
    "architecture",
    "package-manager-cache",
  ],
} as const;

const safeAction = (uses: unknown, inputs: unknown) => {
  if (
    typeof uses !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}$/u.test(uses)
  )
    return false;
  const repository = uses.split("@").at(0);
  const approved = Object.entries(metadataActionInputs).find(
    ([name]) => name === repository,
  );
  if (approved === undefined) return false;
  if (inputs === undefined) return true;
  if (!record(inputs)) return false;
  const [, allowedInputs] = approved;
  return Object.entries(inputs).every(
    ([name, value]) =>
      allowedInputs.some((allowed) => allowed === name) &&
      ["string", "boolean", "number"].includes(typeof value) &&
      (name !== "package-manager-cache" ||
        value === false ||
        value === "false"),
  );
};

const safeShell = (shell: unknown) =>
  shell === undefined || shell === "bash" || shell === "sh";
const safeEnvironment = (value: unknown) =>
  value === undefined ||
  (record(value) &&
    Object.keys(value).every((name) =>
      [
        "HEAD_REPO",
        "BASE_REPO",
        "HAS_RUN_CI_LABEL",
        "PR_TITLE",
        "HEAD_REF",
        "ISSUE_BODY",
        "COMMENT_BODY",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "HAWK_RUST_TOOLCHAIN",
        "HAWK_VERSION",
        "HAWK_X86_64_UNKNOWN_LINUX_GNU_SHA256",
      ].includes(name),
    ));
const configuredShell = (value: unknown) =>
  record(value) && record(value["run"]) ? value["run"]["shell"] : undefined;

export const workflowTrustRules = ["workflow-trust"] as const;

type WorkflowTrustFinding = {
  job: string;
  message: string;
} & (
  | { type: "job"; property: "uses" | "container" | "services" }
  | { type: "step"; step: number }
);

const workflowEvents = (triggers: unknown): unknown[] => {
  if (typeof triggers === "string") return [triggers];
  if (Array.isArray(triggers)) return triggers;
  if (record(triggers)) return Object.keys(triggers);
  return [];
};

/** Enforce a workflow's declared trust boundary before repository dependency execution. */
export const checkWorkflowTrust = (workflow: unknown) => {
  const findings: WorkflowTrustFinding[] = [];
  if (!record(workflow) || !record(workflow["jobs"])) return findings;
  const jobs = workflow["jobs"];
  if (!record(jobs["trust-check"])) return findings;
  const triggers = workflow["on"];
  const events = workflowEvents(triggers);
  const pullRequests = events.filter(
    (event): event is string =>
      event === "pull_request" || event === "pull_request_target",
  );
  if (pullRequests.length === 0) return findings;
  for (const [name, job] of Object.entries(jobs)) {
    if (!record(job)) continue;
    const needs = job["needs"];
    const ordered =
      name !== "trust-check" &&
      (needs === "trust-check" ||
        (Array.isArray(needs) && needs.includes("trust-check")));
    const permitsExecution = (stepCondition: unknown) => {
      const guarded = pullRequests.every(
        (event) =>
          excludesUntrusted({ condition: job["if"], event }) ||
          excludesUntrusted({ condition: stepCondition, event }),
      );
      if (ordered && guarded) return true;
      // Non-PR-only execution needs no dependency on a PR-only trust decision.
      return pullRequests.every(
        (event) =>
          excludesUntrusted({
            condition: job["if"],
            event,
            allowTrust: false,
          }) ||
          excludesUntrusted({
            condition: stepCondition,
            event,
            allowTrust: false,
          }),
      );
    };
    const message = `jobs.${name} repository commands require needs: trust-check and a condition requiring its trusted output on pull requests`;
    const jobUses = job["uses"];
    if (jobUses !== undefined && !permitsExecution(undefined))
      findings.push({ type: "job", property: "uses", job: name, message });
    // Containers and services start before steps, so a step condition cannot
    // authorize them. No image approval catalog is implicit in a digest pin.
    if (!permitsExecution(undefined)) {
      if (job["container"] !== undefined)
        findings.push({
          type: "job",
          property: "container",
          job: name,
          message,
        });
      const services = job["services"];
      if (
        services !== undefined &&
        (!record(services) || Object.keys(services).length > 0)
      )
        findings.push({
          type: "job",
          property: "services",
          job: name,
          message,
        });
    }
    if (!Array.isArray(job["steps"])) continue;
    for (const [index, step] of job["steps"].entries()) {
      if (!record(step)) continue;
      const run = step["run"];
      const uses = step["uses"];
      const unsafeRun =
        typeof run === "string" &&
        (invokesRepositoryCode(run) ||
          !safeShell(
            step["shell"] ??
              configuredShell(job["defaults"]) ??
              configuredShell(workflow["defaults"]),
          ) ||
          ![workflow["env"], job["env"], step["env"]].every(safeEnvironment));
      const unsafeAction =
        uses !== undefined &&
        (!safeAction(uses, step["with"]) ||
          ![workflow["env"], job["env"], step["env"]].every(safeEnvironment));
      if (!unsafeRun && !unsafeAction) continue;
      // Unknown actions can read the caller's workspace before any later step.
      if (permitsExecution(unsafeAction ? undefined : step["if"])) continue;
      findings.push({ type: "step", job: name, step: index, message });
    }
  }
  return findings;
};
