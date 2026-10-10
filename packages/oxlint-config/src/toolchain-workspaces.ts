import path from "node:path";
import picomatch from "picomatch";

type WorkspaceContainsOptions = {
  directory: string;
  file: string;
  patterns: unknown;
  rootMembership: "implicit" | "patterns";
};

/** Match manifest directories with the same positive and negative workspace patterns. */
export const workspaceContains = ({
  directory,
  file,
  patterns,
  rootMembership,
}: WorkspaceContainsOptions) => {
  const relative = path.posix.relative(directory, path.posix.dirname(file));
  if (relative === "" && rootMembership === "implicit") return true;
  if (relative === ".." || relative.startsWith("../")) return false;
  if (!Array.isArray(patterns)) return false;
  const normalize = (pattern: string) => path.posix.normalize(pattern);
  const selected = patterns.filter(
    (value: unknown): value is string => typeof value === "string",
  );
  return (
    picomatch(
      selected.filter((pattern) => !pattern.startsWith("!")).map(normalize),
    )(relative) &&
    !picomatch(
      selected
        .filter((pattern) => pattern.startsWith("!"))
        .map((pattern) => normalize(pattern.slice(1))),
    )(relative)
  );
};
