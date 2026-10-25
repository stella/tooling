import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkNodeProjects } from "./toolchain-node-projects";
import {
  scriptSourceExtensions,
  scriptSourceKind,
} from "./toolchain-script-extensions";

// Literal producer fixtures must cover the complete canonical extension set.
const sourceFixtures = {
  ".js": "export const value = 1;\n",
  ".jsx": "export const value = <div />;\n",
  ".mjs": "export const value = 1;\n",
  ".cjs": "module.exports = { value: 1 };\n",
  ".ts": "export const value: number = 1;\n",
  ".tsx": "export const value = <div />;\n",
  ".mts": "export const value: number = 1;\n",
  ".cts": "export const value: number = 1;\n",
} satisfies Record<keyof typeof scriptSourceExtensions, string>;

test("source kind lookup follows the canonical extension map", () => {
  for (const [extension, kind] of Object.entries(scriptSourceExtensions)) {
    expect(scriptSourceKind(`scripts/source${extension}`)).toBe(kind);
    expect(scriptSourceKind(`scripts/source${extension}.map`)).toBeUndefined();
  }
  expect(scriptSourceKind("README.md")).toBeUndefined();
});

// Both subprocesses only enumerate files/configuration, never lint or typecheck.
test("real lint inventory reports an unowned source of every canonical extension", () => {
  const require = createRequire(import.meta.url);
  const root = mkdtempSync(path.join(tmpdir(), "stll-script-extensions-"));
  const manifest = {
    scripts: { lint: "oxlint --config .oxlintrc.json --type-aware scripts" },
    devDependencies: {
      oxlint: "1.87.0",
      "oxlint-tsgolint": "7.0.2003",
    },
  };
  const orphanFiles = Object.keys(sourceFixtures).map(
    (extension) => `scripts/orphan${extension}`,
  );
  try {
    mkdirSync(path.join(root, "node_modules"));
    mkdirSync(path.join(root, "scripts"));
    for (const dependency of Object.keys(manifest.devDependencies)) {
      symlinkSync(
        path.dirname(require.resolve(`${dependency}/package.json`)),
        path.join(root, "node_modules", dependency),
        "dir",
      );
    }
    writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    writeFileSync(path.join(root, ".oxlintrc.json"), "{}");
    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { allowJs: true, noEmit: true },
        files: ["scripts/owned.ts"],
      }),
    );
    writeFileSync(
      path.join(root, "scripts/owned.ts"),
      "export const owned = 1;\n",
    );
    for (const [extension, source] of Object.entries(sourceFixtures)) {
      writeFileSync(path.join(root, `scripts/orphan${extension}`), source);
    }
    const trackedFiles = new Set([
      "package.json",
      ".oxlintrc.json",
      "tsconfig.json",
      "scripts/owned.ts",
      ...orphanFiles,
    ]);
    const diagnostics = checkNodeProjects({ root, manifest, trackedFiles });
    expect(diagnostics.map(({ path: file }) => file)).toEqual(
      orphanFiles.toSorted((left, right) => left.localeCompare(right)),
    );
    expect(
      diagnostics.every(({ message }) => message.includes("inferred project")),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
