import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import picomatch from "picomatch";

import { lintInventoryCommands } from "./toolchain-lint-command";

export const nodeProjectRule = "type-aware-projects";

type NodeProjectDiagnostic = {
  rule: typeof nodeProjectRule;
  path: string;
  line: number;
  message: string;
};

type ProjectOwnershipOptions = {
  trackedFiles: ReadonlySet<string>;
  lintedFiles: readonly string[];
  projectFiles: ReadonlySet<string>;
};

export const checkProjectOwnership = ({
  trackedFiles,
  lintedFiles,
  projectFiles,
}: ProjectOwnershipOptions): NodeProjectDiagnostic[] =>
  [...new Set(lintedFiles)]
    .filter(
      (file) =>
        /\.(?:[cm]?js|ts)$/.test(file) &&
        trackedFiles.has(file) &&
        !projectFiles.has(file),
    )
    .sort((left, right) => left.localeCompare(right))
    .map((file) => ({
      rule: nodeProjectRule,
      path: file,
      line: 1,
      message:
        "type-aware lint would use an inferred project; include this file in a declared tsconfig project (for Node scripts, add scripts/tsconfig.json extending @stll/typescript-config/node.json; see the Node scripts recipe in stella/tooling README)",
    }));

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const readCommand = (root: string, executable: string, args: string[]) => {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `configuration discovery failed: ${(result.stderr + result.stdout).trim()}`,
    );
  return result.stdout;
};

const relativePath = (root: string, file: string) =>
  path.relative(root, path.resolve(root, file)).split(path.sep).join("/");

type CheckNodeProjectsOptions = {
  root: string;
  manifest: unknown;
  trackedFiles: ReadonlySet<string>;
};

/** Inventory and config expansion only: neither subprocess lints or typechecks. */
export const checkNodeProjects = ({
  root,
  manifest,
  trackedFiles,
}: CheckNodeProjectsOptions) => {
  const inventory = lintInventoryCommands(manifest);
  if (!inventory.enabled) return [];
  const diagnostics: ReturnType<typeof checkProjectOwnership> = [];
  const addConfiguration = (file: string, message: string) =>
    diagnostics.push({ rule: nodeProjectRule, path: file, line: 1, message });
  for (const error of inventory.errors) addConfiguration("package.json", error);
  if (inventory.errors.length !== 0) return diagnostics;
  try {
    const require = createRequire(path.join(root, "package.json"));
    const oxlint = path.join(
      path.dirname(require.resolve("oxlint/package.json")),
      "bin/oxlint",
    );
    const compiler = path.join(
      path.dirname(require.resolve("typescript/package.json")),
      "bin/tsc",
    );
    const commands = inventory.commands.map((args) => ({ cwd: root, args }));
    if (inventory.workspaceTask) {
      const workspaces = record(manifest) ? manifest["workspaces"] : undefined;
      const patterns = record(workspaces) ? workspaces["packages"] : workspaces;
      if (
        !stringList(patterns) ||
        patterns.some((pattern) => pattern.startsWith("!"))
      )
        throw new Error(
          "workspace lint inventory requires declared positive workspace globs",
        );
      const workspaceMatches = picomatch(patterns, { dot: true });
      for (const file of trackedFiles) {
        if (!file.endsWith("/package.json")) continue;
        const directory = path.posix.dirname(file);
        if (!workspaceMatches(directory)) continue;
        const workspace: unknown = JSON.parse(
          readFileSync(path.join(root, file), "utf8"),
        );
        if (
          !record(workspace) ||
          !record(workspace["scripts"]) ||
          workspace["scripts"]["lint"] === undefined
        )
          continue;
        const nested = lintInventoryCommands(workspace, true);
        if (nested.workspaceTask)
          throw new Error(
            `nested workspace lint delegation is unsupported: ${file}`,
          );
        if (nested.errors.length > 0)
          throw new Error(`${file}: ${nested.errors.join("; ")}`);
        for (const args of nested.commands)
          commands.push({ cwd: path.join(root, directory), args });
      }
      if (commands.length === 0)
        throw new Error("workspace lint task has no declared oxlint commands");
    }
    const lintedFiles = commands.flatMap(({ cwd, args }) =>
      readCommand(cwd, oxlint, [...args, "--debug", "files", "--threads", "1"])
        .split(/\r?\n/)
        .filter((file) => file !== "")
        .map((file) => relativePath(root, path.resolve(cwd, file))),
    );
    const projectFiles = new Set<string>();
    const projects = [...trackedFiles].filter((file) => {
      if (path.posix.basename(file) !== "tsconfig.json") return false;
      const parent = path.posix.dirname(file);
      return lintedFiles.some(
        (source) => parent === "." || source.startsWith(`${parent}/`),
      );
    });
    const visited = new Set<string>();
    for (const config of projects) {
      if (visited.has(config)) continue;
      visited.add(config);
      try {
        const project: unknown = JSON.parse(
          readCommand(root, compiler, ["--showConfig", "--project", config]),
        );
        if (!record(project))
          throw new Error("compiler configuration must be an object");
        const references = project["references"] ?? [];
        if (!Array.isArray(references))
          throw new Error("compiler configuration references must be an array");
        for (const reference of references) {
          if (!record(reference) || typeof reference["path"] !== "string")
            throw new Error("compiler project reference requires a path");
          const target = relativePath(
            root,
            path.resolve(root, path.dirname(config), reference["path"]),
          );
          const referencedConfig = target.endsWith(".json")
            ? target
            : path.posix.join(target, "tsconfig.json");
          if (!trackedFiles.has(referencedConfig))
            throw new Error(
              `project reference is not tracked: ${referencedConfig}`,
            );
          projects.push(referencedConfig);
        }
        const sources =
          project["files"] ?? (references.length > 0 ? [] : undefined);
        if (!stringList(sources))
          throw new Error(
            "compiler configuration did not return a files array",
          );
        const options = project["compilerOptions"];
        for (const file of sources) {
          if (
            /\.[cm]?js$/.test(file) &&
            (!record(options) ||
              (options["allowJs"] !== true && options["checkJs"] !== true))
          )
            continue;
          projectFiles.add(
            relativePath(root, path.resolve(root, path.dirname(config), file)),
          );
        }
      } catch (error) {
        addConfiguration(
          config,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    diagnostics.push(
      ...checkProjectOwnership({ trackedFiles, lintedFiles, projectFiles }),
    );
  } catch (error) {
    addConfiguration(
      "package.json",
      error instanceof Error ? error.message : String(error),
    );
  }
  return diagnostics;
};
