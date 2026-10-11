import { expect, test } from "bun:test";

import type { detectToolchainChanges } from "./toolchain-changed";
import { parseChangedArguments } from "./toolchain-changed-args";
import { parseParityArguments } from "./typecheck-parity-args";
import { runSelectedTypecheckParity } from "./typecheck-parity-selection";
import { parseProbeArguments } from "./typecheck-probe-args";

type Changes = Awaited<ReturnType<typeof detectToolchainChanges>>;

test("parity runs without a ref; conditional parity skips only unchanged compiler tools", async () => {
  for (const tools of [
    [],
    ["node"],
    ["shared"],
    ["bun"],
    ["typescript"],
    ["bun", "typescript"],
  ] as const) {
    for (const since of [undefined, "origin/main"]) {
      let runs = 0;
      let report = "";
      const passed = await runSelectedTypecheckParity({
        repo: "/repo",
        since,
        run: async () => {
          runs += 1;
          return false;
        },
        detect: async () =>
          ({
            status: "compared",
            changed: tools.length > 0,
            tools: [...tools],
            current: {
              bun: ["1.4.3"],
              typescript: ["typescript@7.0.2", "typescript-compat@6.0.3"],
            },
          }) satisfies Changes,
        output: (text) => {
          report += text;
        },
      });
      const shouldRun =
        since === undefined ||
        tools.some(
          (tool) =>
            tool === "bun" || tool === "typescript" || tool === "shared",
        );
      expect(runs).toBe(shouldRun ? 1 : 0);
      expect(passed).toBe(!shouldRun);
      if (shouldRun) expect(report).toBe("");
      else
        expect(report).toBe(
          "parity skipped: toolchain unchanged since origin/main (bun 1.4.3, typescript typescript@7.0.2, typescript-compat@6.0.3)\n",
        );
    }
  }
});

test("unreadable ref runs full parity without skipping", async () => {
  let runs = 0;
  const passed = await runSelectedTypecheckParity({
    repo: "/repo",
    since: "missing-ref",
    run: async () => {
      runs += 1;
      return true;
    },
    detect: async () =>
      ({
        status: "unreadable",
        changed: true,
        tools: ["bun"],
        error: "missing commit",
      }) satisfies Changes,
    output: () => {
      throw new Error("must not report a skip");
    },
  });
  expect(passed).toBe(true);
  expect(runs).toBe(1);
});

test("CLI grammars reject missing, repeated, or unknown selectors before running commands", () => {
  expect(
    parseParityArguments([
      "--changed-since",
      "origin/main",
      "--project",
      "packages/api/tsconfig.json",
    ]),
  ).toEqual({
    mode: "selected",
    projects: ["packages/api/tsconfig.json"],
    changedSince: "origin/main",
  });
  expect(parseChangedArguments(["--since", "HEAD~1"])).toEqual({
    mode: "compare",
    since: "HEAD~1",
  });
  expect(
    parseProbeArguments([
      "--project",
      "tsconfig.json",
      "--",
      "bun",
      "run",
      "typecheck",
    ]),
  ).toEqual({
    mode: "probe",
    project: "tsconfig.json",
    command: ["bun", "run", "typecheck"],
  });
  for (const args of [
    ["--changed-since"],
    ["--changed-since", "a", "--changed-since", "b"],
    ["--changed-since", "--bad"],
    ["--unknown"],
  ])
    expect(() => parseParityArguments(args)).toThrow("Usage:");
  for (const args of [
    [],
    ["--since"],
    ["--since", "-bad"],
    ["--since", "HEAD", "extra"],
  ])
    expect(() => parseChangedArguments(args)).toThrow("Usage:");
  for (const args of [
    [],
    ["--project", "tsconfig.json"],
    ["--project", "tsconfig.json", "--"],
    ["--project", "tsconfig.json", "bun", "check"],
  ])
    expect(() => parseProbeArguments(args)).toThrow("Usage:");
  for (const parse of [
    parseParityArguments,
    parseChangedArguments,
    parseProbeArguments,
  ])
    expect(parse(["--help"])).toEqual({ mode: "help" });
});
