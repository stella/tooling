import { expect, test } from "bun:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

import manifest from "../package.json";

const graphImports = async (entry: URL) => {
  const result = await build({
    entryPoints: [fileURLToPath(entry)],
    bundle: true,
    packages: "external",
    platform: "node",
    write: false,
    metafile: true,
    treeShaking: false,
    logLevel: "silent",
  });
  return new Set(
    Object.values(result.metafile.inputs).flatMap(({ imports }) =>
      imports.map(({ path }) => path),
    ),
  );
};

const toolingDependencies = ["yaml", "picomatch", "smol-toml"];

test("lint entry excludes tooling parsers while the Dependabot subpath retains them", async () => {
  const root = await graphImports(new URL("./index.ts", import.meta.url));
  const tooling = await graphImports(
    new URL("./dependabot.ts", import.meta.url),
  );
  for (const dependency of toolingDependencies) {
    expect(root.has(dependency), dependency).toBe(false);
    expect(tooling.has(dependency), dependency).toBe(true);
  }
  expect(manifest.exports["./dependabot"].import.default).toBe(
    "./dist/dependabot.mjs",
  );
  expect(manifest.exports["./dependabot"].require.default).toBe(
    "./dist/dependabot.cjs",
  );
});

test.skipIf(process.env["CI"] !== "true")(
  "published lint entry graphs exclude tooling parsers",
  async () => {
    for (const target of [
      manifest.exports["."].import.default,
      manifest.exports["."].require.default,
    ]) {
      const imports = await graphImports(
        new URL(`../${target}`, import.meta.url),
      );
      for (const dependency of toolingDependencies)
        expect(imports.has(dependency), dependency).toBe(false);
    }
  },
);
