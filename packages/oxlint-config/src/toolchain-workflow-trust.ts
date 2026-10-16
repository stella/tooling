import path from "node:path";

import {
  decodeShellWord,
  executableShellWords,
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
    condition.trim().replace(/^\$\{\{([\s\S]*)\}\}$/u, "$1").trim(),
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
  const trustComparison = /^needs\.trust-check\.outputs\.trusted\s*==\s*'([^']*)'$/u.exec(source);
  if (allowTrust && trustComparison?.at(1)?.toLowerCase() === "true")
    return true;
  if (source === "false") return true;
  const comparison = /^github\.event_name\s*(==|!=)\s*'([^']+)'$/u.exec(source);
  if (comparison === null) return false;
  // Actions compares string values without regard to case.
  const equal = comparison.at(2)?.toLowerCase() === event.toLowerCase();
  return comparison.at(1) === "==" ? !equal : equal;
};

const invokesRepositoryCode = (command: string) =>
  shellCommandSegments(command).some((segment) => {
    let words = executableShellWords(segment).map(decodeShellWord);
    while (["command", "exec"].includes(words.at(0) ?? "")) {
      const wrapper = words.at(0);
      let start = 1;
      while (start < words.length) {
        const option = words.at(start) ?? "";
        if (option === "--") {
          start++;
          break;
        }
        if (wrapper === "command" && /^-[pVv]+$/u.test(option)) {
          if (/[vV]/u.test(option)) return false;
          start++;
          continue;
        }
        if (wrapper === "exec" && option === "-a") {
          start += 2;
          continue;
        }
        if (wrapper === "exec" && /^-[cl]+$/u.test(option)) {
          start++;
          continue;
        }
        break;
      }
      words = executableShellWords(words.slice(start));
    }
    const executable = words.at(0) ?? "";
    if (
      executable.startsWith("./") || executable.startsWith("../") ||
      (!path.posix.isAbsolute(executable) && !executable.includes("$") && executable.includes("/")) ||
      /(?:^|\/)node_modules\/\.bin\//u.test(executable)
    ) return true;
    if (words.some((word) => /(?:^|\/)node_modules\/\.bin\//u.test(word))) {
      if (
        ["node", "bun", "bash", "sh"].includes(path.posix.basename(executable))
      )
        return true;
    }
    const name = path.posix.basename(executable);
    if (["bunx", "npx", "pnpx"].includes(name)) return true;
    if (["node", "bash", "sh", "python", "python3"].includes(name))
      return words.slice(1).some((word) =>
        /^(?!-)(?:\.?\.?\/)?[^$]*\.(?:[cm]?[jt]s|sh|py)$/u.test(word),
      );
    // These managers can load repository-owned manager code or configuration
    // hooks independently of lifecycle-script suppression.
    if (["pnpm", "yarn", "yarnpkg"].includes(name)) return true;
    if (name !== "bun" && name !== "npm") return false;
    const argumentsAfterOptions = words.slice(1);
    if (
      argumentsAfterOptions.length === 1 &&
      ["--version", "-v", "--help", "-h"].includes(argumentsAfterOptions.at(0) ?? "")
    ) return false;
    const installationArguments: string[] = [];
    for (let index = 0; index < argumentsAfterOptions.length; index++) {
      const argument = argumentsAfterOptions.at(index) ?? "";
      if (["--cwd", "-C", "--filter", "-F", "--prefix", "--workspace", "-w"].includes(argument)) {
        // A missing or option-shaped value cannot establish an install-only command.
        const value = argumentsAfterOptions.at(index + 1);
        if (value === undefined || value.startsWith("-")) return true;
        index++;
        continue;
      }
      installationArguments.push(argument);
    }
    const commandIndex = installationArguments.findIndex((argument) => !argument.startsWith("-"));
    const subcommand = installationArguments.at(commandIndex);
    if (commandIndex < 0 || !["install", "i", "ci"].includes(subcommand ?? "")) return true;
    // Only a statically understood install with disabled scripts can precede trust.
    // Unknown flags (including eval/preload forms) always retain the trust requirement.
    const flags = installationArguments.filter((_argument, index) => index !== commandIndex);
    const scriptsDisabled = flags.some((flag) => flag === "--ignore-scripts" || flag === "--ignore-scripts=true");
    return !scriptsDisabled || flags.some((flag) =>
      !/^(?:--frozen-lockfile|--ignore-scripts(?:=true)?|--no-(?:audit|fund|progress|save|cache|summary)|--production|--prefer-offline|--offline|--(?:audit|fund|progress)=false)$/u.test(flag),
    );
  });

export const workflowTrustRules = ["workflow-trust"] as const;

type WorkflowTrustFinding = {
  job: string;
  message: string;
} & (
  | { type: "job" }
  | { type: "step"; step: number }
);

/** Enforce a workflow's declared trust boundary before repository dependency execution. */
export const checkWorkflowTrust = (workflow: unknown) => {
  const findings: WorkflowTrustFinding[] = [];
  if (!record(workflow) || !record(workflow["jobs"])) return findings;
  const jobs = workflow["jobs"];
  if (!record(jobs["trust-check"])) return findings;
  const triggers = workflow["on"];
  const events =
    typeof triggers === "string"
      ? [triggers]
      : Array.isArray(triggers)
        ? triggers
        : record(triggers)
          ? Object.keys(triggers)
          : [];
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
      const guarded = pullRequests.every((event) =>
        excludesUntrusted({ condition: job["if"], event }) ||
        excludesUntrusted({ condition: stepCondition, event }),
      );
      if (ordered && guarded) return true;
      // Non-PR-only execution needs no dependency on a PR-only trust decision.
      return pullRequests.every((event) =>
        excludesUntrusted({ condition: job["if"], event, allowTrust: false }) ||
        excludesUntrusted({ condition: stepCondition, event, allowTrust: false }),
      );
    };
    const message = `jobs.${name} repository commands require needs: trust-check and a condition requiring its trusted output on pull requests`;
    const jobUses = job["uses"];
    if (
      typeof jobUses === "string" &&
      jobUses.startsWith("./") &&
      !permitsExecution(undefined)
    )
      findings.push({ type: "job", job: name, message });
    if (!Array.isArray(job["steps"])) continue;
    for (const [index, step] of job["steps"].entries()) {
      if (!record(step)) continue;
      const run = step["run"];
      const uses = step["uses"];
      if (
        !(typeof run === "string" && invokesRepositoryCode(run)) &&
        !(typeof uses === "string" && uses.startsWith("./"))
      )
        continue;
      if (permitsExecution(step["if"])) continue;
      findings.push({ type: "step", job: name, step: index, message });
    }
  }
  return findings;
};
