const marker = "# stll-rust-policy-owned-v1: ";
const markerPrefix = "# stll-rust-policy-owned-";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Arrays are policy values; inline TOML tables expose individually owned leaves. */
export const policyLeaves = (
  table: Record<string, unknown>,
  prefix: string[] = [],
): string[][] =>
  Object.entries(table)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) =>
      record(value)
        ? policyLeaves(value, [...prefix, key])
        : [[...prefix, key]],
    );

const inManagedScope = (file: string, path: string[]) => {
  if (file === "rustfmt.toml" || file === "clippy.toml")
    return path.length === 1;
  if (file === ".cargo/config.toml")
    return path.length === 2 && path.at(0) === "alias";
  if (!file.endsWith("Cargo.toml")) return false;
  const root = file === "Cargo.toml";
  if (root && path.at(0) === "profile")
    return (
      path.length === 3 && ["release", "dev", "ci"].includes(path.at(1) ?? "")
    );
  const lintPath = path.at(0) === "workspace" && root ? path.slice(1) : path;
  if (lintPath.at(0) !== "lints") return false;
  if (lintPath.length === 2) return lintPath.at(1) === "workspace";
  if (!["rust", "rustdoc", "clippy"].includes(lintPath.at(1) ?? ""))
    return false;
  return (
    lintPath.length === 3 ||
    (lintPath.length === 4 &&
      ["level", "priority"].includes(lintPath.at(3) ?? ""))
  );
};

const validatePaths = (file: string, input: unknown) => {
  if (!Array.isArray(input)) throw new Error("invalid Rust ownership metadata");
  const paths = input.map((entry: unknown) => {
    if (
      !Array.isArray(entry) ||
      entry.length === 0 ||
      !entry.every(
        (part: unknown) =>
          typeof part === "string" &&
          /^[A-Za-z0-9_-]+$/.test(part) &&
          !["__proto__", "constructor", "prototype"].includes(part),
      )
    )
      throw new Error("invalid Rust ownership path");
    const path = entry.map((part: unknown) => {
      if (typeof part !== "string") throw new Error("invalid ownership path");
      return part;
    });
    if (!inManagedScope(file, path))
      throw new Error(`Rust ownership metadata escapes managed scope: ${file}`);
    return path;
  });
  const seen = new Set<string>();
  for (const path of paths) {
    const key = JSON.stringify(path);
    if (seen.has(key)) throw new Error("duplicate Rust ownership path");
    seen.add(key);
    for (let length = 1; length < path.length; length++)
      if (
        paths.some(
          (other) =>
            JSON.stringify(other) === JSON.stringify(path.slice(0, length)),
        )
      )
        throw new Error("overlapping Rust ownership paths");
  }
  return paths;
};

export const ownershipHeader = (
  file: string,
  owned: Record<string, unknown>,
) => {
  // Resolver is a project-owned setting, even when seeded by the template.
  const paths = policyLeaves(owned).filter(
    (path) => JSON.stringify(path) !== '["workspace","resolver"]',
  );
  validatePaths(file, paths);
  return `${marker}${JSON.stringify(paths)}\n`;
};

const removeLeaf = (table: Record<string, unknown>, path: string[]) => {
  const key = path.at(0);
  if (key === undefined || !Object.hasOwn(table, key)) return;
  const value = table[key];
  if (path.length === 1) {
    if (record(value))
      throw new Error(
        "Rust ownership leaf became a table; resolve ownership explicitly",
      );
    Reflect.deleteProperty(table, key);
    return;
  }
  if (!record(value))
    throw new Error(
      "Rust ownership table became a value; resolve ownership explicitly",
    );
  removeLeaf(value, path.slice(1));
  if (Object.keys(value).length === 0) Reflect.deleteProperty(table, key);
};

const previousPolicyPaths = (file: string, current: string | undefined) => {
  const declarations: string[] = [];
  // Metadata belongs to the leading comment block, never a TOML string value.
  for (const line of (current ?? "").split("\n")) {
    if (line.trim() !== "" && !line.startsWith("#")) break;
    if (line.startsWith(markerPrefix)) declarations.push(line);
  }
  if (declarations.length === 0) return undefined;
  const declaration = declarations.at(0);
  if (
    declarations.length !== 1 ||
    declaration === undefined ||
    !declaration.startsWith(marker)
  )
    throw new Error("invalid Rust ownership metadata version or count");
  const paths = validatePaths(
    file,
    JSON.parse(declaration.slice(marker.length)),
  );
  return paths;
};

export const removePreviousPolicy = (
  file: string,
  current: string | undefined,
  document: Record<string, unknown>,
) => {
  for (const path of previousPolicyPaths(file, current) ?? [])
    removeLeaf(document, path);
};

export const removePreviousMemberPolicy = (
  file: string,
  current: string,
  document: Record<string, unknown>,
) => {
  const paths = previousPolicyPaths(file, current);
  if (paths === undefined) {
    const lints = document["lints"];
    if (record(lints) && Object.hasOwn(lints, "workspace"))
      throw new Error(
        `retired member must retain its generated inheritance ownership: ${file}`,
      );
    return "unmanaged";
  }
  if (paths.some((path) => JSON.stringify(path) !== '["lints","workspace"]'))
    throw new Error(
      `retired member must retain its generated inheritance ownership: ${file}`,
    );
  for (const path of paths) removeLeaf(document, path);
  return "owned";
};

const memberMarker = "# stll-rust-policy-members-v1: ";
const memberPrefix = "# stll-rust-policy-members-";
const memberPaths = (input: unknown) => {
  if (!Array.isArray(input))
    throw new Error("invalid Rust member ownership index");
  const paths = input.map((value: unknown) => {
    if (
      typeof value !== "string" ||
      value === "Cargo.toml" ||
      !value.endsWith("/Cargo.toml") ||
      value.includes("\\") ||
      /\p{Cc}/u.test(value) ||
      /^[A-Za-z]:/u.test(value) ||
      value
        .split("/")
        .some((part) => part === "." || part === ".." || part === "")
    )
      throw new Error(
        "Rust member ownership paths must be canonical repository Cargo.toml paths",
      );
    return value;
  });
  if (new Set(paths).size !== paths.length)
    throw new Error("duplicate Rust member ownership path");
  return paths;
};

export const previousMemberPaths = (source: string) => {
  const declarations: string[] = [];
  for (const line of source.split("\n")) {
    if (line.trim() !== "" && !line.startsWith("#")) break;
    if (line.startsWith(memberPrefix)) declarations.push(line);
  }
  if (declarations.length === 0) return [];
  const declaration = declarations.at(0);
  if (
    declarations.length !== 1 ||
    declaration === undefined ||
    !declaration.startsWith(memberMarker)
  )
    throw new Error("invalid Rust member ownership index version or count");
  return memberPaths(JSON.parse(declaration.slice(memberMarker.length)));
};

export const memberOwnershipHeader = (members: string[]) =>
  `${memberMarker}${JSON.stringify(memberPaths(members.filter((file) => file !== "Cargo.toml")))}\n`;
