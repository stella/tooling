import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { discoverConsumerManifests } from "./consumer-compat-config";
import { lintInventoryCommands } from "./toolchain-lint-command";
import { scriptSourceKind } from "./toolchain-script-extensions";
import type {
  LifecycleFile,
  ScriptLifecycleContext,
} from "./toolchain-script-lifecycle";

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
        scriptSourceKind(file) !== undefined &&
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

type ReadCommandOptions = {
  root: string;
  executable: string;
  args: string[];
  runtime: "node" | "bun";
};

const readCommand = ({
  root,
  executable,
  args,
  runtime,
}: ReadCommandOptions) => {
  const result = spawnSync(
    runtime,
    [...(runtime === "bun" ? ["--bun"] : []), executable, ...args],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
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

const lifecycleFile = (
  root: string,
  file: string,
  tracked: ReadonlySet<string>,
): LifecycleFile => {
  try {
    const location = path.join(root, file);
    const metadata = lstatSync(location);
    if (!tracked.has(file) || !metadata.isFile()) return { type: "unknown" };
    return { type: "tracked", source: readFileSync(location, "utf8") };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { type: "absent" };
    return { type: "unknown" };
  }
};

/** Inventory and config expansion only: neither subprocess lints or typechecks. */
export const checkNodeProjects = ({
  root,
  manifest,
  trackedFiles,
}: CheckNodeProjectsOptions) => {
  let members: ReturnType<typeof discoverConsumerManifests> | undefined;
  // One membership source for filtered builds and workspace lint tasks: package
  // workspaces and pnpm-workspace.yaml, including exclusion patterns.
  const workspaceMembers = () => {
    if (members === undefined) {
      const files: Record<string, string> = {
        "package.json": JSON.stringify(manifest),
      };
      // pnpm-workspace.yaml declares membership only when pnpm is the manager;
      // other managers may track it for settings alone.
      const packageManager = record(manifest)
        ? manifest["packageManager"]
        : undefined;
      const pnpmMembership =
        packageManager === undefined ||
        (typeof packageManager === "string" &&
          packageManager.startsWith("pnpm@"));
      for (const file of trackedFiles) {
        const name = path.posix.basename(file);
        if (
          file !== "package.json" &&
          (name === "package.json" ||
            (pnpmMembership && name === "pnpm-workspace.yaml")) &&
          !file.split("/").includes("node_modules")
        )
          files[file] = readFileSync(path.join(root, file), "utf8");
      }
      members = discoverConsumerManifests(files);
    }
    return members;
  };
  const filteredCommands: (ReturnType<
    typeof lintInventoryCommands
  >["commands"][number] & { cwd: string })[] = [];
  const activeBuilds = new Set<string>();
  const workspaceLifecycle = (directory: string): ScriptLifecycleContext => {
    const nestedLifecycle = { ...lifecycle };
    for (const [key, name] of [
      ["npmrc", ".npmrc"],
      ["pnpmWorkspace", "pnpm-workspace.yaml"],
      ["yarnrc", ".yarnrc.yml"],
    ] as const) {
      let ancestor = directory;
      while (ancestor !== ".") {
        if (
          lifecycleFile(root, path.posix.join(ancestor, name), trackedFiles)
            .type !== "absent"
        ) {
          nestedLifecycle[key] = { type: "unknown" };
          break;
        }
        ancestor = path.posix.dirname(ancestor);
      }
    }
    return nestedLifecycle;
  };
  const lifecycle: ScriptLifecycleContext = {
    packageManager: record(manifest) ? manifest["packageManager"] : undefined,
    npmrc: lifecycleFile(root, ".npmrc", trackedFiles),
    pnpmWorkspace: lifecycleFile(root, "pnpm-workspace.yaml", trackedFiles),
    yarnrc: lifecycleFile(root, ".yarnrc.yml", trackedFiles),
    assertFilteredBunBuild: (selector) => {
      const selected = [...workspaceMembers().entries()].filter(
        ([, pkg]) => pkg["name"] === selector,
      );
      if (selected.length !== 1)
        throw new Error(
          "Filtered Bun build requires one declared workspace package",
        );
      const member = selected.at(0);
      if (member === undefined) throw new Error("Missing selected workspace");
      const [directory, pkg] = member;
      const scripts = pkg["scripts"];
      if (!record(scripts) || typeof scripts["build"] !== "string")
        throw new Error("Filtered Bun build requires a literal build script");
      if (
        ["prebuild", "postbuild"].some(
          (name) => scripts[name] !== undefined && scripts[name] !== "",
        )
      )
        throw new Error(
          "Filtered Bun build lifecycle hooks are unsupported for lint inventory; invoke lint scopes explicitly",
        );
      if (activeBuilds.has(directory))
        throw new Error("Cyclic filtered Bun build delegation");
      activeBuilds.add(directory);
      try {
        const nested = lintInventoryCommands(pkg, true, {
          ...workspaceLifecycle(directory),
          entryScript: "build",
        });
        if (nested.workspaceTask)
          throw new Error(
            "Nested workspace lint delegation is unsupported in filtered builds",
          );
        if (nested.errors.length > 0)
          throw new Error(
            `${directory}/package.json: ${nested.errors.join("; ")}`,
          );
        for (const command of nested.commands)
          filteredCommands.push({
            cwd: path.join(root, directory),
            ...command,
          });
      } finally {
        activeBuilds.delete(directory);
      }
    },
  };
  const inventory = lintInventoryCommands(manifest, false, lifecycle);
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
    const commands = inventory.commands.map((command) => ({
      cwd: root,
      ...command,
    }));
    if (inventory.workspaceTask) {
      for (const [directory, workspace] of workspaceMembers()) {
        if (directory === ".") continue;
        const file = `${directory}/package.json`;
        if (
          !record(workspace["scripts"]) ||
          workspace["scripts"]["lint"] === undefined
        )
          continue;
        const nestedLifecycle = workspaceLifecycle(directory);
        const nested = lintInventoryCommands(workspace, true, nestedLifecycle);
        if (nested.workspaceTask)
          throw new Error(
            `nested workspace lint delegation is unsupported: ${file}`,
          );
        if (nested.errors.length > 0)
          throw new Error(`${file}: ${nested.errors.join("; ")}`);
        for (const command of nested.commands)
          commands.push({ cwd: path.join(root, directory), ...command });
      }
      if (commands.length === 0 && filteredCommands.length === 0)
        throw new Error("workspace lint task has no declared oxlint commands");
    }
    commands.push(...filteredCommands);
    // Filtered builds only count once their expanded bodies invoke oxlint.
    if (commands.length === 0)
      throw new Error("root lint scripts contain no supported oxlint invocation");
    const lintedFiles = commands.flatMap(({ cwd, args, runtime }) =>
      readCommand({
        root: cwd,
        executable: oxlint,
        args: [...args, "--debug", "files", "--threads", "1"],
        runtime,
      })
        .split(/\r?\n/)
        .filter((file) => file !== "")
        .map((file) => relativePath(root, path.resolve(cwd, file))),
    );
    const nearestProject = (start: string) => {
      let directory = start;
      while (true) {
        const config = path.posix.join(directory, "tsconfig.json");
        if (trackedFiles.has(config)) return config;
        if (directory === ".") return undefined;
        directory = path.posix.dirname(directory);
      }
    };
    const groups = new Map<string, string[]>();
    for (const file of new Set(lintedFiles)) {
      if (!trackedFiles.has(file) || scriptSourceKind(file) === undefined)
        continue;
      const config = nearestProject(path.posix.dirname(file));
      if (config === undefined) continue;
      const group = groups.get(config);
      if (group === undefined) groups.set(config, [file]);
      else group.push(file);
    }
    type Project = { files: Set<string>; references: string[] };
    const projects = new Map<string, Project>();
    const readProject = (config: string): Project => {
      const cached = projects.get(config);
      if (cached !== undefined) return cached;
      const result: Project = { files: new Set(), references: [] };
      try {
        const project: unknown = JSON.parse(
          readCommand({
            root,
            executable: compiler,
            args: ["--showConfig", "--project", config],
            runtime: "node",
          }),
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
          result.references.push(referencedConfig);
        }
        // --showConfig omits `files` when the project owns no roots.
        const sources = project["files"] ?? [];
        if (!stringList(sources))
          throw new Error(
            "compiler configuration did not return a files array",
          );
        const options = project["compilerOptions"];
        for (const file of sources) {
          if (
            scriptSourceKind(file) === "javascript" &&
            (!record(options) ||
              (options["allowJs"] !== true && options["checkJs"] !== true))
          )
            continue;
          result.files.add(
            relativePath(root, path.resolve(root, path.dirname(config), file)),
          );
        }
      } catch (error) {
        result.files.clear();
        result.references.length = 0;
        addConfiguration(
          config,
          error instanceof Error ? error.message : String(error),
        );
      }
      projects.set(config, result);
      return result;
    };
    const projectFiles = new Set<string>();
    for (const [nearest, sources] of groups) {
      const remaining = new Set(sources);
      const visited = new Set<string>();
      let ancestor: string | undefined = nearest;
      while (ancestor !== undefined && remaining.size > 0) {
        const pending = [ancestor];
        let config = pending.pop();
        while (config !== undefined && remaining.size > 0) {
          if (!visited.has(config)) {
            visited.add(config);
            const project = readProject(config);
            for (const source of remaining) {
              if (!project.files.has(source)) continue;
              projectFiles.add(source);
              remaining.delete(source);
            }
            pending.push(...project.references);
          }
          config = pending.pop();
        }
        const directory = path.posix.dirname(ancestor);
        ancestor =
          directory === "."
            ? undefined
            : nearestProject(path.posix.dirname(directory));
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
