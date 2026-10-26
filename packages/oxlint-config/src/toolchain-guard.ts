import { execFileSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { cloudSetupPath, generateCloudSetup } from "./cloud-setup";
import {
  cloudAttributionFix,
  cloudClaudeSettingsPath,
  cloudSessionStartFix,
  hasCloudAttribution,
  hasCloudSessionStartHook,
} from "./cloud-setup-claude";
import { parseCloudSetup } from "./cloud-setup-schema";
import { readGitTrackedOutput } from "./git-tracked-output";
import { checkRepositoryQuarantine } from "./quarantine-policy";
import { repositoryBun } from "./toolchain-bun";
import {
  checkConsumerChecks,
  parseConsumerChecks,
} from "./toolchain-consumer-checks";
import {
  checkDependabot,
  declaredIgnoreConflicts,
  dependabotRules,
  parseDependabotIgnores,
} from "./toolchain-dependabot";
import {
  type DynamicSelector,
  parseDynamicSelectors,
} from "./toolchain-dynamic-selectors";
import {
  parseEngineFloors,
  type ResolvedEngineFloor,
  resolveEngineFloor,
} from "./toolchain-engine-floors";
import { checkFormatter, formatterRule } from "./toolchain-formatter";
import { toolchainInputKind } from "./toolchain-inputs";
import { checkNodeProjects, nodeProjectRule } from "./toolchain-node-projects";
import {
  checkPackageFiles,
  packageRules,
  parseTypescriptAllowlist,
} from "./toolchain-packages";
import {
  checkRuntimeFile,
  type RuntimeDelegation,
  runtimeRules,
} from "./toolchain-runtime";
import { parseRustExceptions } from "./toolchain-rust";
import { parseToolchainPolicy } from "./toolchain-schema";

export const toolchainRules = [
  ...new Set([
    ...packageRules,
    ...runtimeRules,
    ...dependabotRules,
    nodeProjectRule,
    formatterRule,
    "cloud-setup-drift",
    "quarantine-policy",
  ] as const),
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

/** Repository-owned declarations are explicit; malformed decisions fail closed. */
export const parseToolchainConfiguration = (input: unknown) => {
  if (
    !record(input) ||
    Object.keys(input).some(
      (key) =>
        key !== "optOuts" &&
        key !== "cloud" &&
        key !== "engineFloors" &&
        key !== "dynamicSelectors" &&
        key !== "consumerChecks" &&
        key !== "rustExceptions" &&
        key !== "dependabotIgnores" &&
        key !== "typescriptAllowlist",
    ) ||
    (input["optOuts"] !== undefined && !array(input["optOuts"]))
  )
    throw new Error(
      "stll-toolchain.json accepts only optOuts, cloud, engineFloors, dynamicSelectors, consumerChecks, rustExceptions, dependabotIgnores and typescriptAllowlist declarations",
    );
  const disabled = new Set<string>();
  const optOuts = input["optOuts"] ?? [];
  if (!array(optOuts)) throw new Error("optOuts must be an array");
  for (const entry of optOuts) {
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
    if (entry["rule"] === "quarantine-policy")
      throw new Error(
        "quarantine-policy cannot be opted out; temporary third-party exclusions require expiry",
      );
    if (entry["rule"] === "rust-version")
      throw new Error(
        "rust-version requires expiring exact-pin rustExceptions, not an opt-out",
      );
    if (entry["rule"] === "node-engine")
      throw new Error(
        "node-engine cannot be opted out; engines.node must support the shared Node series",
      );
    if (entry["rule"] === "workflow-trust")
      throw new Error(
        "workflow-trust cannot be opted out; repository commands must follow the declared trust decision",
      );
    if (entry["rule"] === "cloud-setup-drift")
      throw new Error(
        "cloud-setup-drift cannot be opted out; generated setup must match shared policy",
      );
    if (entry["rule"] === nodeProjectRule)
      throw new Error(
        "type-aware-projects cannot be opted out; linted files require declared TypeScript projects",
      );
    disabled.add(entry["rule"]);
  }
  return {
    disabled,
    rustExceptions: parseRustExceptions(input["rustExceptions"]),
    cloud: parseCloudSetup(input["cloud"]),
    engineFloors: parseEngineFloors(input["engineFloors"]),
    dynamicSelectors: parseDynamicSelectors(input["dynamicSelectors"]),
    consumerChecks: parseConsumerChecks(input["consumerChecks"]),
    dependabotIgnores: parseDependabotIgnores(input["dependabotIgnores"]),
    typescriptAllowlist: parseTypescriptAllowlist(input["typescriptAllowlist"]),
  };
};

type ReadToolchainInputsOptions = {
  bunLock?: "presence" | "content";
};

/** Dependency graphs stay opaque unless a caller explicitly needs registry identities. */
export const readToolchainInputs = (
  root: string,
  { bunLock = "presence" }: ReadToolchainInputsOptions = {},
) => {
  const diagnostics: SharedToolchainDiagnostic[] = [];
  const tracked = readGitTrackedOutput(root, "staged")
    .split("\0")
    // Gitlinks identify submodule directories, never executable script files.
    .filter((entry) => entry !== "" && !entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
  const files: Record<string, string> = {};
  const trackedFiles = new Set(tracked);
  const resolvedRoot = realpathSync(root);
  for (const file of tracked) {
    // Only configuration inputs are read; source files can contain arbitrary examples.
    const kind = toolchainInputKind(file);
    const shebangCandidate =
      kind === undefined &&
      path.posix.extname(file) === "" &&
      !file
        .split("/")
        .some((part) => part === "vendor" || part === "node_modules");
    if (kind === undefined && !shebangCandidate) continue;
    try {
      const inputPath = path.join(resolvedRoot, file);
      if (
        kind === "presence" &&
        !(file === "bun.lock" && bunLock === "content")
      ) {
        // The index can retain deleted declarations; presence follows the worktree.
        lstatSync(inputPath);
        files[file] = "";
        continue;
      }
      if (shebangCandidate) {
        const input = lstatSync(inputPath);
        if (!input.isFile() && !input.isSymbolicLink()) continue;
      }
      const resolvedFile = realpathSync(inputPath);
      const relative = path.relative(resolvedRoot, resolvedFile);
      if (
        path.isAbsolute(relative) ||
        relative.split(path.sep).at(0) === ".." ||
        !trackedFiles.has(relative.split(path.sep).join("/"))
      )
        throw new Error("Configuration target is outside the tracked tree");
      if (shebangCandidate) {
        if (!lstatSync(resolvedFile).isFile()) continue;
        // Bound discovery reads: extensionless files may be large binary artifacts.
        const descriptor = openSync(resolvedFile, "r");
        const prefix = Buffer.alloc(512);
        let count: number;
        try {
          count = readSync(descriptor, prefix, 0, prefix.length, 0);
        } finally {
          closeSync(descriptor);
        }
        if (
          toolchainInputKind(file, prefix.toString("utf8", 0, count)) ===
          undefined
        )
          continue;
      }
      files[file] = readFileSync(resolvedFile, "utf8");
    } catch (error) {
      if (
        kind === "presence" &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )
        continue;
      if (shebangCandidate) continue;
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
  onDelegated?: ((report: RuntimeDelegation) => void) | undefined;
  onWarning?: ((report: SharedToolchainDiagnostic) => void) | undefined;
  now?: Date | undefined;
};

export const checkToolchain = ({
  root,
  policy: sharedPolicy,
  onDelegated,
  onWarning,
  now,
}: CheckSharedToolchainOptions) => {
  const { files, trackedFiles, diagnostics } = readToolchainInputs(root, {
    bunLock: "content",
  });
  // Every Bun reference follows the repository's own pin, which must be at
  // or above the shared minimum.
  const policy = {
    ...sharedPolicy,
    bun: repositoryBun(sharedPolicy.bun, files["package.json"]),
  };
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

  let configuration = parseToolchainConfiguration({});
  const engineFloors: ResolvedEngineFloor[] = [];
  let dynamicSelectors: DynamicSelector[] = [];
  if (files["stll-toolchain.json"] !== undefined) {
    try {
      configuration = parseToolchainConfiguration(
        JSON.parse(files["stll-toolchain.json"]),
      );
      dynamicSelectors = configuration.dynamicSelectors;
      for (const entry of configuration.engineFloors)
        engineFloors.push(resolveEngineFloor(entry, files));
    } catch (error) {
      diagnostics.push({
        rule: "configuration",
        path: "stll-toolchain.json",
        line: 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const cloud = configuration.cloud;
  const script = files[cloudSetupPath];
  if (cloud === undefined && trackedFiles.has(cloudSetupPath))
    diagnostics.push({
      rule: "cloud-setup-drift",
      path: cloudSetupPath,
      line: 1,
      message:
        "cloud setup script requires an explicit cloud declaration in stll-toolchain.json",
    });
  if (cloud !== undefined) {
    if (!hasCloudSessionStartHook(files[cloudClaudeSettingsPath]))
      diagnostics.push({
        rule: "cloud-setup-drift",
        path: cloudClaudeSettingsPath,
        line: 1,
        message: `tracked Claude cloud SessionStart hook is missing, disabled or differs from shared policy; run stll-cloud-setup; if automatic merge is unsafe, ${cloudSessionStartFix}`,
      });
    if (!hasCloudAttribution(files[cloudClaudeSettingsPath]))
      diagnostics.push({
        rule: "cloud-setup-drift",
        path: cloudClaudeSettingsPath,
        line: 1,
        message: `tracked Claude attribution is missing or differs from shared policy; run stll-cloud-setup; if automatic merge is unsafe, ${cloudAttributionFix}`,
      });
    try {
      const nodeVersion = files[".node-version"];
      if (nodeVersion === undefined)
        throw new Error(
          "cloud setup requires a tracked root .node-version with an exact stable release",
        );
      const expected = generateCloudSetup({
        policy,
        cloud,
        nodeVersion: nodeVersion.trim(),
        files,
        rustExceptions: configuration.rustExceptions,
      });
      if (script !== expected)
        diagnostics.push({
          rule: "cloud-setup-drift",
          path: cloudSetupPath,
          line: 1,
          message:
            "cloud setup script is missing or differs from shared policy; run stll-cloud-setup",
        });
    } catch (error) {
      diagnostics.push({
        rule: "cloud-setup-drift",
        path: cloudSetupPath,
        line: 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const exercisedFloors = new Set<ResolvedEngineFloor>();
  const mismatchedFloors = new Set<ResolvedEngineFloor>();

  const selectorMatches = new Map<DynamicSelector, number>();
  diagnostics.push(
    ...checkConsumerChecks({
      declarations: configuration.consumerChecks,
      files,
      policy,
    }),
  );
  diagnostics.push(
    ...checkPackageFiles({
      files,
      policy,
      typescriptAllowlist: configuration.typescriptAllowlist,
    }),
  );
  const usesBun = Object.entries(files).some(([file, text]) => {
    if (path.posix.basename(file) === "bun.lock") return true;
    if (path.posix.basename(file) !== "package.json") return false;
    try {
      const manifest: unknown = JSON.parse(text);
      return (
        record(manifest) &&
        typeof manifest["packageManager"] === "string" &&
        /^bun(?:@|$)/u.test(manifest["packageManager"])
      );
    } catch {
      // Package diagnostics already reject malformed manifests.
      return false;
    }
  });
  diagnostics.push(
    ...checkFormatter({ files, policy: policy.formatter, usesBun }),
  );
  if (usesBun || files["bunfig.toml"] !== undefined) {
    try {
      if (files["bunfig.toml"] === undefined)
        throw new Error(
          "Bun repositories require a tracked root bunfig.toml with the five-day quarantine policy; use the documented pinned bunx stll-quarantine --sync bootstrap, then commit bunfig.toml",
        );
      const result = checkRepositoryQuarantine({
        files,
        now,
        npmrcPresent: trackedFiles.has(".npmrc"),
      });
      for (const message of result.errors)
        diagnostics.push({
          rule: "quarantine-policy",
          path: "bunfig.toml",
          line: 1,
          message,
        });
      for (const message of result.warnings)
        onWarning?.({
          rule: "quarantine-policy",
          path: "bunfig.toml",
          line: 1,
          message,
        });
    } catch (error) {
      diagnostics.push({
        rule: "quarantine-policy",
        path: "bunfig.toml",
        line: 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (files["package.json"] !== undefined) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(files["package.json"]);
    } catch {
      // The package manifest guard reports invalid JSON.
    }
    diagnostics.push(...checkNodeProjects({ root, manifest, trackedFiles }));
  }
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
        rustExceptions: configuration.rustExceptions,
        dynamicSelectors: dynamicSelectors.filter(
          (entry) => entry.path === file,
        ),
        onDynamicSelector: (entry) =>
          selectorMatches.set(entry, (selectorMatches.get(entry) ?? 0) + 1),
        repository,
        onDelegated,
        engineFloors: engineFloors.filter((entry) => entry.workflow === file),
        onEngineFloor: (entry, status) => {
          if (status === "mismatch") mismatchedFloors.add(entry);
          else exercisedFloors.add(entry);
        },
        readFile: (target) => files[target],
      }),
    );
  for (const entry of engineFloors)
    if (!exercisedFloors.has(entry) || mismatchedFloors.has(entry))
      diagnostics.push({
        rule: "configuration",
        path: "stll-toolchain.json",
        line: 1,
        message: `engine floor ${entry.workflow}:${entry.job} requires a setup-node exact patch satisfying ${entry.package} engines.node minimum major ${entry.major}`,
      });
  for (const entry of dynamicSelectors)
    if (selectorMatches.get(entry) !== 1)
      diagnostics.push({
        rule: "configuration",
        path: "stll-toolchain.json",
        line: 1,
        message: `dynamic selector ${entry.path}:${entry.at ?? entry.line} must match exactly one unresolved ${entry.kind} selector`,
      });
  const dependabotIgnores = configuration.dependabotIgnores;
  for (const message of declaredIgnoreConflicts({
    ignores: dependabotIgnores,
    policy: policy.dependabot,
  }))
    diagnostics.push({
      rule: "configuration",
      path: "stll-toolchain.json",
      line: 1,
      message,
    });
  diagnostics.push(
    ...checkDependabot({
      files,
      policy: policy.dependabot,
      ignores: dependabotIgnores,
    }),
  );
  return diagnostics.filter(
    (diagnostic) => !configuration.disabled.has(diagnostic.rule),
  );
};
