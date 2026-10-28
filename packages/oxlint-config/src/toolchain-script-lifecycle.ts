import { parseDocument } from "yaml";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type LifecycleFile =
  | { type: "absent" }
  | { type: "tracked"; source: string }
  | { type: "unknown" };

export type ScriptLifecycleContext = {
  packageManager?: unknown;
  npmrc?: LifecycleFile;
  pnpmWorkspace?: LifecycleFile;
  yarnrc?: LifecycleFile;
  assertFilteredBunBuild?: (selector: string) => void;
};

const declaredManager = (value: unknown) =>
  typeof value === "string"
    ? /^(bun|npm|pnpm|yarn)@(\d+\.\d+\.\d+)(?:\+\S+)?$/u.exec(value)
    : null;

export const rootScriptManager = (
  manifest: unknown,
  context: ScriptLifecycleContext,
) =>
  declaredManager(
    context.packageManager ??
      (record(manifest) ? manifest["packageManager"] : undefined),
  )?.at(1);

const npmHooksEnabled = (file: LifecycleFile | undefined) => {
  if (file?.type === "unknown")
    throw new Error(
      "npm lifecycle configuration must be a tracked regular file",
    );
  if (file?.type !== "tracked") return true;
  let enabled = true;
  let section = false;
  for (const raw of file.source.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      section = true;
      continue;
    }
    if (section || !/^ignore-scripts(?:\s*=|\s*$)/iu.test(line)) continue;
    if (!/^ignore-scripts(?:\s*=|\s*$)/u.test(line))
      throw new Error(
        "npm ignore-scripts must use its canonical lowercase key",
      );
    const value = line.slice(line.indexOf("=") + 1).trim();
    if (value !== "true" && value !== "false")
      throw new Error(
        "npm ignore-scripts must be a literal boolean for lifecycle discovery",
      );
    enabled = value === "false";
  }
  return enabled;
};

const yamlSettings = (
  file: LifecycleFile | undefined,
  manager: string,
): Record<string, unknown> => {
  if (file?.type === "unknown")
    throw new Error(
      `${manager} lifecycle configuration requires tracked regular root files without nested workspace overrides`,
    );
  if (file?.type !== "tracked") return {};
  const document = parseDocument(file.source);
  if (document.errors.length > 0)
    throw new Error(`Cannot parse ${manager} lifecycle configuration`);
  let settings: unknown;
  try {
    settings = document.toJS();
  } catch {
    throw new Error(`Cannot parse ${manager} lifecycle configuration`);
  }
  if (!record(settings))
    throw new Error(`${manager} lifecycle configuration must be a mapping`);
  return settings;
};

// Existing consumers on 12.9.1 retain their verified lifecycle behavior.
export const pnpmLifecycleVersions = ["12.9.1", "12.15.0"] as const;

const pnpmHooksEnabled = (
  manifest: Record<string, unknown>,
  context: ScriptLifecycleContext,
) => {
  const declared = declaredManager(
    context.packageManager ?? manifest["packageManager"],
  );
  const dependency = [manifest["dependencies"], manifest["devDependencies"]]
    .flatMap((field) => (record(field) ? [field["pnpm"]] : []))
    .find((value) => typeof value === "string");
  const version = declared?.at(1) === "pnpm" ? declared.at(2) : dependency;
  if (!pnpmLifecycleVersions.some((supported) => version === supported))
    throw new Error(
      `pnpm lifecycle discovery requires declared pnpm@${pnpmLifecycleVersions.join(" or pnpm@")}`,
    );
  const settings = yamlSettings(context.pnpmWorkspace, "pnpm");
  if ("include" in settings)
    throw new Error(
      "Delegated pnpm settings require explicit lifecycle discovery support",
    );
  const enabled = settings["enablePrePostScripts"];
  if (enabled === undefined) return true;
  if (typeof enabled !== "boolean")
    throw new Error("pnpm enablePrePostScripts must be a literal boolean");
  return enabled;
};

type LifecycleStagesOptions = {
  name: string;
  manager: string | undefined;
  manifest: Record<string, unknown>;
  scripts: Record<string, unknown>;
  context: ScriptLifecycleContext;
};

/** Automatic pre/post stages run their bodies directly, without pre-pre recursion. */
export const scriptLifecycleStages = ({
  name,
  manager,
  manifest,
  scripts,
  context,
}: LifecycleStagesOptions) => {
  const hooks = [`pre${name}`, `post${name}`];
  const present = hooks.filter(
    (hook) => scripts[hook] !== undefined && scripts[hook] !== "",
  );
  if (present.length === 0) return [name];
  if (present.some((hook) => typeof scripts[hook] !== "string"))
    throw new Error(
      `Lifecycle hooks for ${name} must be literal package scripts`,
    );
  let enabled: boolean;
  switch (manager) {
    case "npm":
      enabled = npmHooksEnabled(context.npmrc);
      break;
    case "bun":
      enabled = true;
      break;
    case "pnpm":
      enabled = pnpmHooksEnabled(manifest, context);
      break;
    case "yarn": {
      const declaration = declaredManager(
        context.packageManager ?? manifest["packageManager"],
      );
      if (
        declaration?.at(1) !== "yarn" ||
        !/^[234]\./u.test(declaration.at(2) ?? "")
      )
        throw new Error(
          "Yarn lifecycle discovery requires a declared Berry version (2, 3 or 4)",
        );
      const settings = yamlSettings(context.yarnrc, "Yarn");
      if (
        (settings["yarnPath"] !== undefined && settings["yarnPath"] !== null) ||
        (settings["plugins"] !== undefined &&
          (!Array.isArray(settings["plugins"]) ||
            settings["plugins"].length > 0))
      )
        throw new Error(
          "Custom Yarn executables or plugins require explicit lifecycle discovery support",
        );
      enabled = false;
      break;
    }
    default:
      throw new Error(
        `Cannot determine the package manager for lifecycle hooks of ${name}`,
      );
  }
  if (!enabled) return [name];
  const source = scripts[name];
  const include = (hook: string) =>
    present.includes(hook) &&
    !(
      manager === "pnpm" &&
      typeof source === "string" &&
      source.includes(hook)
    );
  return [
    ...(include(`pre${name}`) ? [`pre${name}`] : []),
    name,
    ...(include(`post${name}`) ? [`post${name}`] : []),
  ];
};
