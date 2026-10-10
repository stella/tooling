import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { checkDependabot, dependabotRules } from "./toolchain-dependabot";
import { toolchainInputKind } from "./toolchain-inputs";
import { checkPackageFiles, packageRules } from "./toolchain-packages";
import { checkRuntimeFile, runtimeRules } from "./toolchain-runtime";
import { parseToolchainPolicy } from "./toolchain-schema";

export const toolchainRules = [
  ...new Set([...packageRules, ...runtimeRules, ...dependabotRules]),
] as const;
export type ToolchainRule = (typeof toolchainRules)[number];
export type SharedToolchainDiagnostic = {
  rule: ToolchainRule | "configuration";
  path: string;
  line: number;
  message: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const array = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

/** Opt-outs are repository-owned, tracked decisions; malformed decisions fail closed. */
export const parseToolchainOptOuts = (input: unknown) => {
  if (
    !record(input) ||
    Object.keys(input).some((key) => key !== "optOuts") ||
    !array(input["optOuts"])
  )
    throw new Error('stll-toolchain.json must contain only an "optOuts" array');
  const disabled = new Set<string>();
  for (const entry of input["optOuts"]) {
    if (
      !record(entry) ||
      Object.keys(entry).some((key) => key !== "rule" && key !== "reason") ||
      typeof entry["rule"] !== "string" ||
      !toolchainRules.some((rule) => rule === entry["rule"]) ||
      typeof entry["reason"] !== "string" ||
      entry["reason"].trim() === "" ||
      disabled.has(entry["rule"])
    )
      throw new Error(
        "each opt-out requires a unique known rule and a nonempty reason",
      );
    disabled.add(entry["rule"]);
  }
  return disabled;
};

/** Read one tracked configuration snapshot for guards and policy generation. */
export const readToolchainInputs = (root: string) => {
  const diagnostics: SharedToolchainDiagnostic[] = [];
  const tracked = execFileSync("git", ["ls-files", "-z", "--cached"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(
      (file) =>
        file !== "" &&
        !file
          .split("/")
          .some((part) => part === "node_modules" || part === "vendor"),
    );
  const files: Record<string, string> = {};
  const trackedFiles = new Set(tracked);
  const resolvedRoot = realpathSync(root);
  for (const file of tracked) {
    // Only configuration inputs are read; source files can contain arbitrary examples.
    const kind = toolchainInputKind(file);
    if (kind === undefined) continue;
    if (kind === "presence") {
      files[file] = "";
      continue;
    }
    try {
      const resolvedFile = realpathSync(path.join(resolvedRoot, file));
      const relative = path.relative(resolvedRoot, resolvedFile);
      if (
        path.isAbsolute(relative) ||
        relative.split(path.sep).at(0) === ".." ||
        !trackedFiles.has(relative.split(path.sep).join("/"))
      )
        throw new Error("Configuration target is outside the tracked tree");
      files[file] = readFileSync(resolvedFile, "utf8");
    } catch {
      diagnostics.push({
        rule: "configuration",
        path: file,
        line: 1,
        message: "cannot read tracked configuration file",
      });
    }
  }
  return { files, trackedFiles, diagnostics };
};

type CheckSharedToolchainOptions = {
  root: string;
  policy: ReturnType<typeof parseToolchainPolicy>;
};

export const checkToolchain = ({
  root,
  policy,
}: CheckSharedToolchainOptions) => {
  const { files, trackedFiles, diagnostics } = readToolchainInputs(root);
  let repository: string | undefined;
  try {
    const origin = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    repository =
      /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
        origin,
      )?.[1];
  } catch {
    // Repositories without a GitHub origin can still use github.repository.
  }

  let disabled = new Set<string>();
  if (files["stll-toolchain.json"] !== undefined) {
    try {
      disabled = parseToolchainOptOuts(
        JSON.parse(files["stll-toolchain.json"]),
      );
    } catch (error) {
      diagnostics.push({
        rule: "configuration",
        path: "stll-toolchain.json",
        line: 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  diagnostics.push(...checkPackageFiles({ files, policy }));
  for (const [file, text] of Object.entries(files))
    diagnostics.push(
      ...checkRuntimeFile({
        file,
        text,
        policy: {
          ...policy,
          packages: { ...policy.packages, typescript: policy.typescript },
        },
        trackedFiles,
        repository,
        readFile: (target) => files[target],
      }),
    );
  diagnostics.push(...checkDependabot({ files, policy: policy.dependabot }));
  return diagnostics.filter((diagnostic) => !disabled.has(diagnostic.rule));
};
