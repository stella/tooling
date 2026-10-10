export type DynamicSelector = {
  path: string;
  kind: "image" | "bun-source";
  reason: string;
} & ({ at: string; line?: never } | { line: number; at?: never });

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One reviewed declaration identifies one unresolved selector, never a rule. */
export const parseDynamicSelectors = (input: unknown): DynamicSelector[] => {
  if (input === undefined) return [];
  if (!Array.isArray(input))
    throw new Error("dynamicSelectors must be an array");
  const result: DynamicSelector[] = [];
  const keys = new Set<string>();
  for (const entry of input) {
    if (
      !record(entry) ||
      Object.keys(entry).some(
        (key) => !["path", "kind", "reason", "at", "line"].includes(key),
      ) ||
      typeof entry["path"] !== "string" ||
      entry["path"] === "" ||
      /[\\\s:$*?]/.test(entry["path"]) ||
      entry["path"]
        .split("/")
        .some((part) => part === "" || part === "." || part === "..") ||
      typeof entry["reason"] !== "string" ||
      entry["reason"].trim() === ""
    )
      throw new Error(
        "each dynamic selector requires an exact repository path, known kind and nonempty reason",
      );
    const kind = entry["kind"];
    if (kind !== "image" && kind !== "bun-source")
      throw new Error("unknown dynamic selector kind");
    let selector: DynamicSelector;
    if (
      Object.hasOwn(entry, "line") &&
      !Object.hasOwn(entry, "at") &&
      typeof entry["line"] === "number" &&
      Number.isSafeInteger(entry["line"]) &&
      entry["line"] > 0
    ) {
      selector = {
        path: entry["path"],
        kind,
        reason: entry["reason"],
        line: entry["line"],
      };
    } else if (
      !Object.hasOwn(entry, "line") &&
      typeof entry["at"] === "string" &&
      (kind === "image"
        ? /^(?:jobs\.[\w-]+\.(?:container|services\.[\w-]+)|services\.[\w.-]+\.image)$/.test(
            entry["at"],
          )
        : /^(?:jobs\.[\w-]+|runs)\.steps\.[\w-]+$/.test(entry["at"]))
    ) {
      selector = {
        path: entry["path"],
        kind,
        reason: entry["reason"],
        at: entry["at"],
      };
    } else
      throw new Error(
        "dynamic selector requires one positive line or a kind-specific job/service/step ID locator",
      );
    const key = JSON.stringify([
      selector.path,
      selector.kind,
      selector.at ?? selector.line,
    ]);
    if (keys.has(key))
      throw new Error("dynamic selector locations must be unique");
    keys.add(key);
    result.push(selector);
  }
  return result;
};
