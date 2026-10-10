const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const knownHooks = new WeakSet<object>();

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
  knownHooks.add(before);
  return before;
};

/** Recognize callbacks created by this module instance, without executing them. */
export const isNuxtModuleTargetHook = (value: unknown) =>
  typeof value === "function" && knownHooks.has(value);
