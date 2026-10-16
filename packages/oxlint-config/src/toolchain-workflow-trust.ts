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
  if (
    allowTrust &&
    /^needs\.trust-check\.outputs\.trusted\s*==\s*'true'$/u.test(source)
  )
    return true;
  if (source === "false") return true;
  const comparison = /^github\.event_name\s*(==|!=)\s*'([^']+)'$/u.exec(source);
  if (comparison === null) return false;
  const equal = comparison.at(2) === event;
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
    if (/(?:^|\/)node_modules\/\.bin\//u.test(executable)) return true;
    if (words.some((word) => /(?:^|\/)node_modules\/\.bin\//u.test(word))) {
      if (
        ["node", "bun", "bash", "sh"].includes(path.posix.basename(executable))
      )
        return true;
    }
    const name = path.posix.basename(executable);
    if (name === "bunx" || name === "npx") return true;
    if (["node", "bash", "sh", "python", "python3"].includes(name))
      return words.slice(1).some((word) =>
        /^(?!-)(?:\.?\.?\/)?[^$]*\.(?:[cm]?[jt]s|sh|py)$/u.test(word),
      );
    if (name !== "bun") return false;
    // Dependency installation is non-executing only with lifecycle scripts disabled.
    // Other Bun commands may resolve a repository script or dependency executable.
    const argumentsAfterOptions = words.slice(1);
    for (let index = 0; index < argumentsAfterOptions.length; index++) {
      const argument = argumentsAfterOptions.at(index) ?? "";
      if (["--cwd", "-C", "--filter", "-F"].includes(argument)) {
        index++;
        continue;
      }
      if (argument.startsWith("-")) continue;
      if (["install", "i", "ci"].includes(argument)) {
        const scriptOptions = argumentsAfterOptions.filter((option) =>
          option === "--ignore-scripts" || option.startsWith("--ignore-scripts="),
        );
        return scriptOptions.length === 0 || scriptOptions.some((option) =>
          option !== "--ignore-scripts" && option !== "--ignore-scripts=true",
        );
      }
      return true;
    }
    return false;
  });

export const workflowTrustRules = ["workflow-trust"] as const;

/** Enforce a workflow's declared trust boundary before repository dependency execution. */
export const checkWorkflowTrust = (workflow: unknown) => {
  const findings: { job: string; step: number; message: string }[] = [];
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
    if (!record(job) || !Array.isArray(job["steps"])) continue;
    const needs = job["needs"];
    const ordered =
      name !== "trust-check" &&
      (needs === "trust-check" ||
        (Array.isArray(needs) && needs.includes("trust-check")));
    for (const [index, step] of job["steps"].entries()) {
      if (!record(step)) continue;
      const run = step["run"];
      const uses = step["uses"];
      if (
        !(typeof run === "string" && invokesRepositoryCode(run)) &&
        !(typeof uses === "string" && uses.startsWith("./"))
      )
        continue;
      const guarded = pullRequests.every(
        (event) =>
          excludesUntrusted({ condition: job["if"], event }) ||
          excludesUntrusted({ condition: step["if"], event }),
      );
      if (ordered && guarded) continue;
      // Non-PR-only jobs need no dependency on a PR-only trust decision.
      if (
        pullRequests.every((event) =>
          excludesUntrusted({ condition: job["if"], event, allowTrust: false }) ||
          excludesUntrusted({ condition: step["if"], event, allowTrust: false }),
        )
      )
        continue;
      findings.push({
        job: name,
        step: index,
        message: `jobs.${name} repository commands require needs: trust-check and a condition requiring its trusted output on pull requests`,
      });
    }
  }
  return findings;
};
