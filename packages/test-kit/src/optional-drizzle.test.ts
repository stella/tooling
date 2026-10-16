import { describe, expect, test } from "bun:test";
import { cp, mkdir, symlink } from "node:fs/promises";
import path from "node:path";

import { createTestTmpDir } from "./tmp.ts";

// drizzle-orm is an optional peer used only by `@stll/test-kit/db`. This
// installs the built package next to its runtime dependencies, without
// drizzle-orm, and imports each entry the way a consumer would.
const packageRoot = path.resolve(import.meta.dir, "..");
const resolveFrom = (specifier: string, from: string): string =>
  path.dirname(Bun.resolveSync(`${specifier}/package.json`, from));

const importEntries = (cwd: string, entries: readonly string[]) =>
  Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `for (const entry of ${JSON.stringify(entries)}) await import(entry);`,
    ],
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

describe("optional drizzle-orm peer", () => {
  test("core entries load without drizzle-orm; only /db needs it", async () => {
    await using consumer = await createTestTmpDir("kit-consumer");
    const modules = consumer.join("node_modules");
    const installed = path.join(modules, "@stll", "test-kit");
    await mkdir(installed, { recursive: true });
    for (const file of ["package.json", "dist"]) {
      await cp(path.join(packageRoot, file), path.join(installed, file), {
        recursive: true,
      });
    }
    // Real copies of the runtime dependencies, so module resolution cannot
    // walk back into this workspace and find its dev dependencies.
    const runtime = {
      "@stll/time": resolveFrom("@stll/time", packageRoot),
      "better-result": resolveFrom("better-result", packageRoot),
    };
    const timeRoot = runtime["@stll/time"];
    const timeDependencies = {
      "temporal-polyfill": resolveFrom("temporal-polyfill", timeRoot),
    };
    for (const [name, source] of Object.entries({
      ...runtime,
      ...timeDependencies,
    })) {
      const target = path.join(modules, name);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, {
        recursive: true,
        filter: (from) =>
          !path.relative(source, from).split(path.sep).includes("node_modules"),
      });
    }
    // The polyfill's own dependencies, as an installer would hoist them.
    for (const name of ["temporal-spec", "temporal-utils"]) {
      const source = resolveFrom(name, timeDependencies["temporal-polyfill"]);
      await symlink(source, path.join(modules, name), "dir");
    }

    const core = importEntries(consumer.path, [
      "@stll/test-kit",
      "@stll/test-kit/forbid-network",
    ]);
    expect(core.stderr.toString()).toBe("");
    expect(core.exitCode).toBe(0);

    const db = importEntries(consumer.path, ["@stll/test-kit/db"]);
    expect(db.exitCode).not.toBe(0);
    expect(db.stderr.toString()).toContain("drizzle-orm");
  });
});
