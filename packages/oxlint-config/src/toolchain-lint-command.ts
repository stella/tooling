import { decodeShellWord, shellCommandSegments } from "./toolchain-packages";
import { scriptSourceKind } from "./toolchain-script-extensions";
import {
  rootScriptManager,
  type ScriptLifecycleContext,
  scriptLifecycleStages,
} from "./toolchain-script-lifecycle";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const scriptManagers = new Set(["bun", "npm", "pnpm", "yarn"]);

const valueFlags = new Set([
  "-c",
  "--config",
  "--tsconfig",
  "--ignore-path",
  "--ignore-pattern",
  "-A",
  "--allow",
  "-W",
  "--warn",
  "-D",
  "--deny",
  "-f",
  "--format",
  "--max-warnings",
  "--threads",
  "--report-unused-disable-directives-severity",
]);
const booleanFlags = new Set([
  "--no-ignore",
  "--quiet",
  "--deny-warnings",
  "--silent",
  "--no-error-on-unmatched-pattern",
  "--disable-nested-config",
  "--report-unused-disable-directives",
  "--disable-unicorn-plugin",
  "--disable-oxc-plugin",
  "--disable-typescript-plugin",
  "--import-plugin",
  "--react-plugin",
  "--jsdoc-plugin",
  "--jest-plugin",
  "--vitest-plugin",
  "--jsx-a11y-plugin",
  "--nextjs-plugin",
  "--react-perf-plugin",
  "--promise-plugin",
  "--node-plugin",
  "--vue-plugin",
]);

// Shell expansion changes the argument vector; inventory accepts literal words only.
const literalWord = (raw: string) => {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < raw.length; index++) {
    const character = raw.at(index);
    if (character === "\\" && quote !== "'") {
      index++;
      continue;
    }
    if (character === quote) {
      quote = undefined;
      continue;
    }
    if (quote === undefined && (character === "'" || character === '"')) {
      quote = character;
      continue;
    }
    if (quote !== "'" && (character === "$" || character === "`")) return false;
    if (
      quote === undefined &&
      character !== undefined &&
      /[*?[\]{}~]/.test(character)
    )
      return false;
  }
  return quote === undefined;
};

const inventoryArguments = (raw: readonly string[]) => {
  const args: string[] = [];
  let threadsSeen = false;
  for (let index = 0; index < raw.length; index++) {
    const word = raw.at(index);
    if (word === undefined) break;
    if (!literalWord(word))
      return { error: "oxlint arguments must be literal shell words" };
    const value = decodeShellWord(word);
    if (!value.startsWith("-")) {
      args.push(value);
      continue;
    }
    if (value === "--") {
      // The runner appends its debug flag, so a terminator would hide it as a path.
      return {
        error: "oxlint argument terminators are unsupported for inventory",
      };
    }
    if (value === "--type-aware" || value === "--type-check") continue;
    const equals = value.indexOf("=");
    const flag = equals < 0 ? value : value.slice(0, equals);
    if (booleanFlags.has(flag)) {
      if (equals >= 0)
        return { error: `unexpected value for oxlint flag ${flag}` };
      args.push(value);
      continue;
    }
    if (!valueFlags.has(flag))
      return { error: `unsupported oxlint flag ${flag}` };
    let argument: string;
    if (equals >= 0) {
      argument = value.slice(equals + 1);
      if (argument === "")
        return { error: `missing value for oxlint flag ${flag}` };
    } else {
      const next = raw.at(++index);
      if (
        next === undefined ||
        !literalWord(next) ||
        decodeShellWord(next).startsWith("-")
      )
        return { error: `missing or nonliteral value for oxlint flag ${flag}` };
      argument = decodeShellWord(next);
    }
    if (flag === "--threads") {
      // The pinned inventory process supplies one thread option of its own.
      if (threadsSeen) return { error: "duplicate oxlint flag --threads" };
      if (
        !/^\+?[0-9]+$/u.test(argument) ||
        BigInt(argument) > 18_446_744_073_709_551_615n
      )
        return { error: "invalid integer value for oxlint flag --threads" };
      threadsSeen = true;
      continue;
    }
    if (equals >= 0) args.push(value);
    else args.push(value, argument);
  }
  return { args };
};

type LintInventoryCommand = {
  runtime: "node" | "bun";
  args: string[];
};

/** Extract runtime and arguments for the pinned inventory binary; never execute package-script shell text. */
export const lintInventoryCommands = (
  manifest: unknown,
  forceEnabled = false,
  context: ScriptLifecycleContext & { entryScript?: string } = {},
) => {
  const commands: LintInventoryCommand[] = [];
  const errors: string[] = [];
  const workspaceTasks = new Set<string>();
  const filteredBuilds = new Set<string>();
  const declaresEngine =
    record(manifest) &&
    [manifest["dependencies"], manifest["devDependencies"]].some(
      (dependencies) =>
        record(dependencies) && "oxlint-tsgolint" in dependencies,
    );
  const enabled = forceEnabled || declaresEngine;
  if (!enabled) return { commands, errors, enabled, workspaceTask: false };
  if (!record(manifest))
    return {
      commands,
      errors: ["lint inventory requires an object package manifest"],
      enabled,
      workspaceTask: false,
    };
  const scripts = manifest["scripts"];
  if (!record(scripts))
    return {
      commands,
      errors: ["type-aware linting requires a root lint script"],
      enabled,
      workspaceTask: false,
    };
  const active = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (active.has(name)) {
      errors.push(`cyclic lint script alias: ${name}`);
      return;
    }
    if (visited.has(name)) return;
    const source = scripts[name];
    if (typeof source !== "string") {
      errors.push(`missing literal package script: ${name}`);
      return;
    }
    active.add(name);
    for (const raw of shellCommandSegments(source)) {
      if (raw.length === 0) continue;
      const words = raw.map(decodeShellWord);
      const first = words.at(0);
      if (first === "cd" || first === "pushd" || first === "popd") {
        errors.push(
          `${name}: changing directories is unsupported for lint inventory`,
        );
        continue;
      }
      if (first === "echo" || first === "printf") continue;
      if (first === "turbo") {
        if (
          words.length === 3 &&
          words.at(1) === "run" &&
          words.at(2) === "lint" &&
          raw.every(literalWord)
        )
          workspaceTasks.add(name);
        else if (words.includes("lint") || !raw.every(literalWord))
          errors.push(
            `${name}: workspace lint delegation requires literal turbo run lint without options`,
          );
        continue;
      }
      if (
        first === "bun" &&
        words.length === 4 &&
        words.at(1) === "--filter" &&
        words.at(2) !== "" &&
        !words.at(2)?.startsWith("-") &&
        words.at(3) === "build" &&
        raw.every(literalWord)
      ) {
        const selector = words.at(2);
        try {
          if (
            selector === undefined ||
            context.assertFilteredBunBuild === undefined
          )
            throw new Error(
              "Filtered Bun builds require verified workspace lifecycle context",
            );
          context.assertFilteredBunBuild(selector);
          filteredBuilds.add(selector);
        } catch (error) {
          errors.push(
            error instanceof Error
              ? error.message
              : "Cannot determine filtered build lifecycle stages",
          );
        }
        continue;
      }
      if (
        first !== undefined &&
        scriptManagers.has(first) &&
        words.at(1) === "run"
      ) {
        const target = words.at(2);
        if (
          target !== undefined &&
          first === "bun" &&
          scriptSourceKind(target) !== undefined &&
          typeof scripts[target] !== "string"
        ) {
          if (!raw.every(literalWord))
            errors.push(
              `${name}: validation file commands require literal arguments`,
            );
          continue;
        }
        if (raw.length !== 3 || !raw.every(literalWord)) {
          errors.push(
            `${name}: package script aliases must have one literal name`,
          );
          continue;
        }
        const alias = words.at(2);
        if (alias !== undefined) invoke({ name: alias, manager: first });
        continue;
      }
      let offset: number | undefined;
      if (
        first === "oxlint" ||
        first === "./node_modules/.bin/oxlint" ||
        first === "node_modules/.bin/oxlint"
      )
        offset = 1;
      else if (
        first === "bun" &&
        words.at(1) === "--bun" &&
        words.at(2) === "oxlint"
      )
        offset = 3;
      else if (first === "bunx" && words.at(1) === "oxlint") offset = 2;
      else if (
        first === "bunx" &&
        words.at(1) === "--no-install" &&
        words.at(2) === "oxlint"
      )
        offset = 3;
      if (offset === undefined) {
        if (
          words.some((word) => /(?:^|\/)oxlint(?:@[^/]+)?$/.test(word)) ||
          words.some(
            (word, index) =>
              scriptManagers.has(word) &&
              words.slice(index + 1).includes("run"),
          ) ||
          (words.includes("turbo") && words.includes("lint")) ||
          // Only the literal filtered build form above is modelled; any other
          // filtered Bun invocation could run workspace lint out of inventory.
          (first === "bun" && words.includes("--filter")) ||
          (first !== undefined &&
            scriptManagers.has(first) &&
            !(
              first === "bun" &&
              ["test", "build", "check", "install", "x"].includes(
                words.at(1) ?? "",
              )
            ) &&
            (words.slice(1).some((word) => typeof scripts[word] === "string") ||
              !raw.every(literalWord))) ||
          (raw.at(0) !== undefined && !literalWord(raw.at(0) ?? ""))
        )
          errors.push(`${name}: unsupported or dynamic oxlint launcher`);
        continue;
      }
      if (!raw.slice(0, offset).every(literalWord)) {
        errors.push(`${name}: oxlint launcher must be literal`);
        continue;
      }
      const inventory = inventoryArguments(raw.slice(offset));
      if (inventory.error !== undefined)
        errors.push(`${name}: ${inventory.error}`);
      else
        commands.push({
          runtime: first === "bun" ? "bun" : "node",
          args: inventory.args,
        });
    }
    active.delete(name);
    visited.add(name);
  };
  const activeInvocations = new Set<string>();
  const invoke = ({
    name,
    manager,
  }: {
    name: string;
    manager: string | undefined;
  }) => {
    const key = `${manager ?? "unknown"}:${name}`;
    if (activeInvocations.has(key)) {
      errors.push(`cyclic lint script alias: ${name}`);
      return;
    }
    activeInvocations.add(key);
    try {
      const stages = scriptLifecycleStages({
        name,
        manager,
        manifest,
        scripts,
        context,
      });
      for (const stage of stages) visit(stage);
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error.message
          : "Cannot determine script lifecycle stages",
      );
    } finally {
      activeInvocations.delete(key);
    }
  };
  invoke({
    name: context.entryScript ?? "lint",
    manager: rootScriptManager(manifest, context),
  });
  const workspaceTask = workspaceTasks.size > 0;
  if (
    !declaresEngine &&
    commands.length === 0 &&
    !workspaceTask &&
    filteredBuilds.size === 0 &&
    errors.length === 0
  )
    return { commands, errors, enabled: false, workspaceTask };
  if (
    commands.length === 0 &&
    !workspaceTask &&
    filteredBuilds.size === 0 &&
    context.entryScript === undefined
  )
    errors.push("root lint scripts contain no supported oxlint invocation");
  return {
    commands: errors.length === 0 ? commands : [],
    errors,
    enabled,
    workspaceTask: errors.length === 0 && workspaceTask,
  };
};
