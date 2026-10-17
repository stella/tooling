/// <reference types="bun-types" />

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

import { parseToolchainConfiguration } from "./toolchain-guard";
import {
  checkNodeProjects,
  checkProjectOwnership,
  nodeProjectRule,
} from "./toolchain-node-projects";

const sources = [
  "scripts/a.js",
  "scripts/b.mjs",
  "scripts/c.cjs",
  "scripts/d.ts",
];

test("project ownership cannot be disabled with a repository opt-out", () => {
  expect(() =>
    parseToolchainConfiguration({
      optOuts: [{ rule: nodeProjectRule, reason: "scripts are inferred" }],
    }),
  ).toThrow("cannot be opted out");
});

test("project ownership flags precisely the unowned part of every script extension set", () => {
  for (let mask = 0; mask < 2 ** sources.length; mask++) {
    const owned = sources.filter((_, index) => (mask & (1 << index)) !== 0);
    const diagnostics = checkProjectOwnership({
      trackedFiles: new Set(sources),
      lintedFiles: [...sources].reverse(),
      projectFiles: new Set(owned),
    });
    expect(diagnostics.map(({ path: file }) => file)).toEqual(
      sources.filter((file) => !owned.includes(file)),
    );
    expect(
      diagnostics.every(
        ({ rule, line }) => rule === nodeProjectRule && line === 1,
      ),
    ).toBe(true);
  }
});

test("lint exclusions and untracked files cannot become ownership violations", () => {
  const tracked = ["scripts/ignored.js", "scripts/owned.ts", "README.md"];
  expect(
    checkProjectOwnership({
      trackedFiles: new Set(tracked),
      lintedFiles: ["scripts/owned.ts", "scripts/untracked.mjs", "README.md"],
      projectFiles: new Set(["scripts/owned.ts"]),
    }),
  ).toEqual([]);
});

test("duplicate lint inventories produce one stable diagnostic per orphan", () => {
  const diagnostics = checkProjectOwnership({
    trackedFiles: new Set(sources),
    lintedFiles: [...sources, ...sources].reverse(),
    projectFiles: new Set(),
  });
  expect(diagnostics.map(({ path: file }) => file)).toEqual(sources);
  expect(diagnostics.every(({ message }) => message.includes("tsconfig"))).toBe(
    true,
  );
});

const require = createRequire(import.meta.url);
const fixtureManifest = {
  scripts: { lint: "oxlint --config .oxlintrc.json --type-aware scripts" },
  devDependencies: {
    oxlint: "1.87.0",
    "oxlint-tsgolint": "7.0.2003",
    typescript: "7.0.2",
  },
};
const withInventoryFixture = (
  exercise: (root: string, trackedFiles: Set<string>) => void,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "stll-project-inventory-"));
  const trackedFiles = new Set<string>();
  try {
    mkdirSync(path.join(root, "node_modules"));
    mkdirSync(path.join(root, "scripts"));
    for (const dependency of ["oxlint", "oxlint-tsgolint", "typescript"])
      symlinkSync(
        path.dirname(require.resolve(`${dependency}/package.json`)),
        path.join(root, "node_modules", dependency),
        "dir",
      );
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify(fixtureManifest),
    );
    writeFileSync(
      path.join(root, ".oxlintrc.json"),
      JSON.stringify({ ignorePatterns: ["scripts/lint-excluded/"] }),
    );
    exercise(root, trackedFiles);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

// These subprocesses expand file/config inventories only; no lint or typecheck runs.
test("real inventories honor inherited JSONC includes, compiler excludes and lint excludes", () => {
  withInventoryFixture((root, trackedFiles) => {
    mkdirSync(path.join(root, "config"));
    mkdirSync(path.join(root, "scripts/compiler-excluded"));
    mkdirSync(path.join(root, "scripts/lint-excluded"));
    const owned = "scripts/owned.mjs";
    const orphan = "scripts/compiler-excluded/orphan.mjs";
    const lintExcluded = "scripts/lint-excluded/orphan.js";
    for (const file of [owned, orphan, lintExcluded]) {
      writeFileSync(path.join(root, file), "export const value = 1;\n");
      trackedFiles.add(file);
    }
    // Even real inventory paths are ignored when the repository does not track them.
    writeFileSync(
      path.join(root, "scripts/untracked.js"),
      "export const value = 1;\n",
    );
    writeFileSync(
      path.join(root, "config/base.jsonc"),
      `{
      // The compiler owns JSONC parsing and resolution of inherited relative globs.
      "compilerOptions": { "allowJs": true, "noEmit": true },
      "include": ["../scripts/**/*.mjs"],
      "exclude": ["../scripts/compiler-excluded/**"],
    }`,
    );
    writeFileSync(
      path.join(root, "tsconfig.json"),
      '{"extends":"./config/base.jsonc"}',
    );
    trackedFiles.add("config/base.jsonc");
    trackedFiles.add("tsconfig.json");
    const diagnostics = checkNodeProjects({
      root,
      manifest: fixtureManifest,
      trackedFiles,
    });
    expect(diagnostics.map(({ path: file }) => file)).toEqual([orphan]);
    expect(
      diagnostics.every(({ message }) => message.includes("inferred project")),
    ).toBe(true);

    writeFileSync(
      path.join(root, "tsconfig.json"),
      '{"extends":"./config/base.jsonc","exclude":[]}',
    );
    expect(
      checkNodeProjects({ root, manifest: fixtureManifest, trackedFiles }),
    ).toEqual([]);
  });
});

test("an unreferenced nondefault config cannot claim ownership but a solution reference can", () => {
  withInventoryFixture((root, trackedFiles) => {
    mkdirSync(path.join(root, "config"));
    const source = "scripts/owned.ts";
    writeFileSync(path.join(root, source), "export const value = 1;\n");
    writeFileSync(
      path.join(root, "config/tsconfig.scripts.json"),
      '{"files":["../scripts/owned.ts"]}',
    );
    trackedFiles.add(source);
    trackedFiles.add("config/tsconfig.scripts.json");
    expect(
      checkNodeProjects({ root, manifest: fixtureManifest, trackedFiles }).map(
        ({ path: file }) => file,
      ),
    ).toEqual([source]);

    writeFileSync(
      path.join(root, "tsconfig.json"),
      '{"files":[],"references":[{"path":"./config/tsconfig.scripts.json"}]}',
    );
    trackedFiles.add("tsconfig.json");
    expect(
      checkNodeProjects({ root, manifest: fixtureManifest, trackedFiles }),
    ).toEqual([]);
  });
});

test("workspace inventories preserve package cwd and ignore validation-only tasks and root orphans", () => {
  withInventoryFixture((root, trackedFiles) => {
    const manifest = {
      ...fixtureManifest,
      workspaces: ["packages/*"],
      scripts: { lint: "turbo run lint" },
    };
    const writeTracked = (file: string, contents: string) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), contents);
      trackedFiles.add(file);
    };
    writeTracked("package.json", JSON.stringify(manifest));
    trackedFiles.add(".oxlintrc.json");
    writeTracked("root-orphan.js", "export const value = 1;\n");
    writeTracked(
      "packages/a/package.json",
      JSON.stringify({
        name: "@fixture/a",
        scripts: { lint: "oxlint -c ../../.oxlintrc.json ." },
      }),
    );
    writeTracked("packages/a/src/owned.ts", "export const value = 1;\n");
    const orphan = "packages/a/orphan.mjs";
    writeTracked(orphan, "export const value = 1;\n");
    const project = {
      compilerOptions: { allowJs: true, noEmit: true },
      include: ["**/*.ts", "**/*.mjs"],
    };
    writeTracked(
      "packages/a/tsconfig.json",
      JSON.stringify({
        ...project,
        exclude: ["orphan.mjs"],
      }),
    );
    writeTracked(
      "packages/b/package.json",
      JSON.stringify({
        name: "@fixture/b",
        scripts: { lint: "bun run scripts/validate.ts" },
      }),
    );
    writeTracked(
      "packages/b/scripts/validate.ts",
      'throw new Error("validation task must not execute during inventory");\n',
    );

    const diagnostics = checkNodeProjects({ root, manifest, trackedFiles });
    expect(diagnostics.map(({ path: file }) => file)).toEqual([orphan]);
    expect(
      diagnostics.every(({ message }) => message.includes("inferred project")),
    ).toBe(true);

    writeTracked("packages/a/tsconfig.json", JSON.stringify(project));
    expect(checkNodeProjects({ root, manifest, trackedFiles })).toEqual([]);
  });
});

test("explicitly selected tracked configs establish ownership without a default project", () => {
  withInventoryFixture((root, trackedFiles) => {
    const source = "scripts/selected.ts";
    const selected = "tsconfig.lint.json";
    writeFileSync(path.join(root, source), "export const value = 1;\n");
    writeFileSync(
      path.join(root, selected),
      JSON.stringify({ files: [source] }),
    );
    for (const file of ["package.json", ".oxlintrc.json", source, selected])
      trackedFiles.add(file);
    for (const argument of [
      "--tsconfig tsconfig.lint.json",
      "--tsconfig=tsconfig.lint.json",
    ]) {
      const manifest = {
        ...fixtureManifest,
        scripts: {
          lint: `oxlint -c .oxlintrc.json --type-aware ${argument} .`,
        },
      };
      writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
      expect(checkNodeProjects({ root, manifest, trackedFiles })).toEqual([]);
    }

    // A workspace selector resolves against that package's cwd, not the root.
    const manifest = {
      ...fixtureManifest,
      workspaces: ["packages/*"],
      scripts: { lint: "turbo run lint" },
    };
    writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    mkdirSync(path.join(root, "packages/a/config"), { recursive: true });
    mkdirSync(path.join(root, "packages/a/src"));
    writeFileSync(
      path.join(root, "packages/a/package.json"),
      JSON.stringify({
        name: "@fixture/a",
        scripts: {
          lint: "oxlint -c ../../.oxlintrc.json --type-aware --tsconfig=config/tsconfig.lint.json .",
        },
      }),
    );
    writeFileSync(
      path.join(root, "packages/a/src/selected.ts"),
      "export const value = 1;\n",
    );
    writeFileSync(
      path.join(root, "packages/a/config/tsconfig.lint.json"),
      JSON.stringify({ files: ["../src/selected.ts"] }),
    );
    for (const file of [
      "packages/a/package.json",
      "packages/a/src/selected.ts",
      "packages/a/config/tsconfig.lint.json",
    ])
      trackedFiles.add(file);
    expect(checkNodeProjects({ root, manifest, trackedFiles })).toEqual([]);
  });
});
