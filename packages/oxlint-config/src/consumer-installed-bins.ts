import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const consumerReservedToolBins = ["node", "npm", "npx", "pnpm"] as const;

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** Dependency lifecycle PATHs include nested and virtual-store node_modules bins. */
export const assertConsumerInstalledToolBins = async (directory: string) => {
  const root = await realpath(directory);
  const visited = new Set<string>();
  const assertContained = (canonical: string) => {
    const relative = path.relative(root, canonical);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error(
        "installed consumer dependency path must stay within the fixture",
      );
  };
  const visit = async (location: string) => {
    const canonical = await realpath(location);
    assertContained(canonical);
    if (
      path.basename(location) === ".bin" &&
      path.basename(path.dirname(location)) === "node_modules"
    ) {
      for (const name of consumerReservedToolBins) {
        try {
          await lstat(path.join(location, name));
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        throw new Error(
          `installed consumer binary ${name} conflicts with the pinned tool before lifecycle scripts`,
        );
      }
    }
    if (visited.has(canonical)) return;
    visited.add(canonical);
    for (const entry of await readdir(canonical, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(path.join(canonical, entry.name));
      else if (entry.isSymbolicLink()) {
        const target = await realpath(path.join(canonical, entry.name));
        assertContained(target);
        if ((await lstat(target)).isDirectory())
          await visit(path.join(canonical, entry.name));
      }
    }
  };
  const modules = path.join(root, "node_modules");
  try {
    await lstat(modules);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  await visit(modules);
};
