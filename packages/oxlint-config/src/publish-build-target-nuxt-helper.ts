const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const targetHookBrand = Symbol.for("@stll/oxlint-config.build-target.nuxt");
const targetHookVersion = 1;

/** Configure both module and runtime JavaScript without replacing Nuxt entries. */
export const nuxtModuleTarget = (target: string | string[]) => {
  const targets = typeof target === "string" ? [target] : [...target];
  if (targets.length === 0 || targets.some((item) => item.length === 0))
    throw new Error("Nuxt module target must contain a JavaScript target");
  const before = (context: unknown) => {
    if (!record(context) || !record(context["options"]))
      throw new Error("Invalid Nuxt build context");
    const options = context["options"];
    if (
      !record(options["rollup"]) ||
      !Array.isArray(options["entries"]) ||
      options["entries"].length === 0
    )
      throw new Error("Invalid resolved Nuxt build options");
    for (const entry of options["entries"]) {
      if (
        !record(entry) ||
        (entry["builder"] !== "rollup" && entry["builder"] !== "mkdist")
      )
        throw new Error("Unsupported Nuxt JavaScript entry builder");
      if (entry["builder"] === "mkdist") {
        const esbuild = entry["esbuild"];
        if (esbuild !== undefined && !record(esbuild))
          throw new Error("Invalid Nuxt runtime transform options");
        entry["esbuild"] = { ...esbuild, target: [...targets] };
      }
    }
    const esbuild = options["rollup"]["esbuild"];
    if (esbuild !== undefined && !record(esbuild))
      throw new Error("Invalid Nuxt module transform options");
    options["rollup"]["esbuild"] = { ...esbuild, target: [...targets] };
  };
  Object.defineProperty(before, targetHookBrand, {
    value: Object.freeze({
      version: targetHookVersion,
      targets: Object.freeze([...targets]),
    }),
  });
  return before;
};

/** Read immutable target data across ESM and CommonJS without executing the callback. */
export const nuxtModuleTargetTargets = (value: unknown) => {
  if (typeof value !== "function") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, targetHookBrand);
  if (
    descriptor === undefined ||
    descriptor.enumerable !== false ||
    descriptor.writable !== false ||
    descriptor.configurable !== false
  )
    return undefined;
  const marker: unknown = descriptor.value;
  if (!record(marker) || !Object.isFrozen(marker)) return undefined;
  const keys = Reflect.ownKeys(marker);
  if (
    keys.length !== 2 ||
    !keys.includes("version") ||
    !keys.includes("targets")
  )
    return undefined;
  const version = Object.getOwnPropertyDescriptor(marker, "version");
  const targetData = Object.getOwnPropertyDescriptor(marker, "targets");
  if (
    !version ||
    !("value" in version) ||
    !targetData ||
    !("value" in targetData)
  )
    return undefined;
  const markerVersion: unknown = version.value;
  if (markerVersion !== targetHookVersion) return undefined;
  const targets: unknown = targetData.value;
  if (
    !Array.isArray(targets) ||
    !Object.isFrozen(targets) ||
    targets.length === 0
  )
    return undefined;
  if (Reflect.ownKeys(targets).length !== targets.length + 1) return undefined;
  const result: string[] = [];
  for (let index = 0; index < targets.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(targets, String(index));
    if (!entry || !("value" in entry)) return undefined;
    const target: unknown = entry.value;
    if (typeof target !== "string" || target.length === 0) return undefined;
    result.push(target);
  }
  return result;
};

/** Recognize the same declared target data across ESM and CommonJS modules. */
export const isNuxtModuleTargetHook = (value: unknown) =>
  nuxtModuleTargetTargets(value) !== undefined;
