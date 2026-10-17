import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  checkWorkflowTrust,
  workflowTrustBootstrapCatalog,
} from "./toolchain-workflow-trust";

test("documented bootstrap catalog equals the production dispatch and input policies", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const start = "<!-- workflow-trust-bootstrap-catalog:start -->";
  const end = "<!-- workflow-trust-bootstrap-catalog:end -->";
  expect(readme.split(start)).toHaveLength(2);
  expect(readme.split(end)).toHaveLength(2);
  const section = readme.slice(
    readme.indexOf(start) + start.length,
    readme.indexOf(end),
  );
  const match = /```json\s*([\s\S]*?)```/u.exec(section);
  expect(match).not.toBeNull();
  const source = match?.at(1);
  if (source === undefined)
    throw new Error("Missing documented bootstrap catalog");
  const documented: unknown = JSON.parse(source);
  expect(documented).toEqual(workflowTrustBootstrapCatalog);
});

const commandExamples = {
  test: "test -n literal",
  "[": "[ literal = literal ]",
  "[[": "[[ literal == literal ]]",
  true: "true",
  false: "false",
  exit: "exit 0",
  echo: "echo literal",
  printf: "printf '%s' literal",
  git: "git rev-parse --verify HEAD",
  gh: "gh api repos/stella/tooling",
} as const satisfies Record<
  keyof typeof workflowTrustBootstrapCatalog.commands,
  string
>;

test("every documented command kind reaches its bounded metadata validator", () => {
  for (const command of Object.values(commandExamples)) {
    expect(
      checkWorkflowTrust({
        on: "pull_request",
        jobs: {
          "trust-check": { steps: [{ run: "echo trust-decision" }] },
          metadata: { steps: [{ run: command }] },
        },
      }),
      command,
    ).toEqual([]);
  }
});
