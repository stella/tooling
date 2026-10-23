/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { scriptSourceExtensions } from "./toolchain-script-extensions";

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
}, 15_000);

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
    expect(diagnostics.map(({ rule, line }) => ({ rule, line }))).toEqual(
      diagnostics.map(() => ({ rule: nodeProjectRule, line: 1 })),
    );
  }
}, 15_000);

test("lint exclusions and untracked files cannot become ownership violations", () => {
  const tracked = ["scripts/ignored.js", "scripts/owned.ts", "README.md"];
  expect(
    checkProjectOwnership({
      trackedFiles: new Set(tracked),
      lintedFiles: ["scripts/owned.ts", "scripts/untracked.mjs", "README.md"],
      projectFiles: new Set(["scripts/owned.ts"]),
    }),
  ).toEqual([]);
}, 15_000);

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
}, 15_000);

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
}, 15_000);

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
}, 15_000);

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
}, 15_000);

test("import-resolution tsconfig flags cannot claim files excluded by the nearest project", () => {
  withInventoryFixture((root, trackedFiles) => {
    const source = "scripts/orphan.ts";
    const selected = "tsconfig.lint.json";
    writeFileSync(path.join(root, source), "export const value = 1;\n");
    writeFileSync(
      path.join(root, "scripts/owned.ts"),
      "export const value = 1;\n",
    );
    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ files: ["scripts/owned.ts"] }),
    );
    writeFileSync(
      path.join(root, selected),
      JSON.stringify({ files: [source] }),
    );
    for (const file of [
      "package.json",
      ".oxlintrc.json",
      source,
      selected,
      "tsconfig.json",
      "scripts/owned.ts",
    ])
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
      const diagnostics = checkNodeProjects({ root, manifest, trackedFiles });
      expect(diagnostics.map(({ path: file }) => file)).toEqual([source]);
    }

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
    const workspaceOrphan = "packages/a/src/orphan.ts";
    writeFileSync(
      path.join(root, workspaceOrphan),
      "export const value = 1;\n",
    );
    writeFileSync(
      path.join(root, "packages/a/src/owned.ts"),
      "export const value = 1;\n",
    );
    writeFileSync(
      path.join(root, "packages/a/tsconfig.json"),
      JSON.stringify({ files: ["src/owned.ts"] }),
    );
    writeFileSync(
      path.join(root, "packages/a/config/tsconfig.lint.json"),
      JSON.stringify({ files: ["../src/orphan.ts"] }),
    );
    for (const file of [
      "packages/a/package.json",
      workspaceOrphan,
      "packages/a/src/owned.ts",
      "packages/a/tsconfig.json",
      "packages/a/config/tsconfig.lint.json",
    ])
      trackedFiles.add(file);
    expect(
      checkNodeProjects({ root, manifest, trackedFiles }).map(
        ({ path: file }) => file,
      ),
    ).toEqual([workspaceOrphan]);
  });
}, 15_000);

test("ancestor roots can own nearest misses while unreferenced sibling projects cannot", () => {
  withInventoryFixture((root, trackedFiles) => {
    mkdirSync(path.join(root, "scripts/nested"));
    mkdirSync(path.join(root, "scripts/sibling"));
    const orphan = "scripts/nested/orphan.ts";
    const owned = "scripts/nested/owned.ts";
    for (const file of [orphan, owned]) {
      writeFileSync(path.join(root, file), "export const value = 1;\n");
      trackedFiles.add(file);
    }
    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ files: [orphan, owned] }),
    );
    const nearest = "scripts/nested/tsconfig.json";
    writeFileSync(
      path.join(root, nearest),
      JSON.stringify({ files: ["owned.ts"] }),
    );
    writeFileSync(
      path.join(root, "scripts/sibling/tsconfig.json"),
      JSON.stringify({ files: ["../nested/orphan.ts"] }),
    );
    for (const config of [
      "tsconfig.json",
      nearest,
      "scripts/sibling/tsconfig.json",
    ])
      trackedFiles.add(config);
    expect(
      checkNodeProjects({ root, manifest: fixtureManifest, trackedFiles }).map(
        ({ path: file }) => file,
      ),
    ).toEqual([]);

    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ files: [owned] }),
    );
    expect(
      checkNodeProjects({ root, manifest: fixtureManifest, trackedFiles }).map(
        ({ path: file }) => file,
      ),
    ).toEqual([orphan]);

    writeFileSync(
      path.join(root, nearest),
      JSON.stringify({
        files: ["owned.ts"],
        references: [{ path: "../sibling" }],
      }),
    );
    expect(
      checkNodeProjects({ root, manifest: fixtureManifest, trackedFiles }),
    ).toEqual([]);
  });
}, 15_000);

test("imports do not establish root membership but ancestor roots can claim imported files", () => {
  withInventoryFixture((root, trackedFiles) => {
    const entry = "scripts/index.ts";
    const helper = "scripts/helper.ts";
    writeFileSync(
      path.join(root, entry),
      'import { value } from "./helper"; export { value };\n',
    );
    writeFileSync(path.join(root, helper), "export const value = 1;\n");
    writeFileSync(
      path.join(root, "scripts/tsconfig.json"),
      JSON.stringify({ include: ["index.ts"] }),
    );
    for (const file of [entry, helper, "scripts/tsconfig.json"])
      trackedFiles.add(file);
    expect(
      checkNodeProjects({ root, manifest: fixtureManifest, trackedFiles }).map(
        ({ path: file }) => file,
      ),
    ).toEqual([helper]);
    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ files: [helper] }),
    );
    trackedFiles.add("tsconfig.json");
    expect(
      checkNodeProjects({ root, manifest: fixtureManifest, trackedFiles }),
    ).toEqual([]);
  });
}, 15_000);

const documentedNodeProject = () => {
  const readme = readFileSync(
    new URL("../../../README.md", import.meta.url),
    "utf8",
  );
  const block = readme
    .split("then add `scripts/tsconfig.json`:")
    .at(1)
    ?.match(/```json\n([\s\S]*?)\n```/u)
    ?.at(1);
  if (block === undefined)
    throw new Error("Missing Node scripts project recipe");
  const recipe: unknown = JSON.parse(block);
  if (
    typeof recipe !== "object" ||
    recipe === null ||
    !("extends" in recipe) ||
    typeof recipe.extends !== "string" ||
    !("include" in recipe) ||
    !Array.isArray(recipe.include) ||
    !recipe.include.every((entry: unknown) => typeof entry === "string")
  )
    throw new Error("Invalid Node scripts project recipe");
  expect(recipe.extends).toBe("@stll/typescript-config/node.json");
  const compare = (left: string, right: string) => left.localeCompare(right);
  expect(recipe.include.toSorted(compare)).toEqual(
    Object.keys(scriptSourceExtensions)
      .map((extension) => `**/*${extension}`)
      .toSorted(compare),
  );
  return { extends: recipe.extends, include: recipe.include };
};

test("the documented Node script layout gives GitHub tools their own nearest project", () => {
  withInventoryFixture((root, trackedFiles) => {
    const manifest = {
      ...fixtureManifest,
      scripts: {
        lint: "oxlint --config .oxlintrc.json --type-aware scripts .github/tools",
      },
    };
    mkdirSync(path.join(root, ".github/tools"), { recursive: true });
    mkdirSync(path.join(root, "node_modules/@stll"));
    symlinkSync(
      path.resolve(import.meta.dir, "../../typescript-config"),
      path.join(root, "node_modules/@stll/typescript-config"),
      "dir",
    );
    const project = documentedNodeProject();
    const toolSources = Object.keys(scriptSourceExtensions).map(
      (extension) => `.github/tools/check-${extension.slice(1)}${extension}`,
    );
    const recipeSources = [
      ...Object.keys(scriptSourceExtensions).map(
        (extension) => `scripts/release-${extension.slice(1)}${extension}`,
      ),
      ...toolSources,
    ];
    for (const source of recipeSources) {
      writeFileSync(
        path.join(root, source),
        'import { existsSync } from "node:fs";\nexport const found = existsSync(".");\n',
      );
      trackedFiles.add(source);
    }
    writeFileSync(
      path.join(root, "scripts/tsconfig.json"),
      JSON.stringify({
        ...project,
        include: [...project.include, "../.github/tools/**/*.mjs"],
      }),
    );
    trackedFiles.add("scripts/tsconfig.json");
    expect(
      checkNodeProjects({ root, manifest, trackedFiles }).map(
        ({ path: file }) => file,
      ),
    ).toEqual(toolSources.toSorted((left, right) => left.localeCompare(right)));

    writeFileSync(
      path.join(root, "scripts/tsconfig.json"),
      JSON.stringify(project),
    );
    writeFileSync(
      path.join(root, ".github/tools/tsconfig.json"),
      JSON.stringify(project),
    );
    trackedFiles.add(".github/tools/tsconfig.json");
    expect(checkNodeProjects({ root, manifest, trackedFiles })).toEqual([]);
  });
}, 15_000);

test("caller thread options retain real inventory ownership at root and workspace cwd", () => {
  for (const threads of ["--threads 4", "--threads=4"]) {
    for (const workspace of [false, true]) {
      withInventoryFixture((root, trackedFiles) => {
        const directory = workspace ? "packages/a" : "scripts";
        mkdirSync(path.join(root, directory), { recursive: true });
        const source = `${directory}/owned.mjs`;
        writeFileSync(path.join(root, source), "export const value = 1;\n");
        const config = `${directory}/tsconfig.json`;
        writeFileSync(
          path.join(root, config),
          JSON.stringify({
            compilerOptions: { allowJs: true },
            include: ["**/*.mjs"],
          }),
        );
        trackedFiles.add(source);
        trackedFiles.add(config);
        const lint = `oxlint --config ${workspace ? "../../" : ""}.oxlintrc.json ${threads} ${workspace ? "." : "scripts"}`;
        const manifest = workspace
          ? {
              ...fixtureManifest,
              workspaces: ["packages/*"],
              scripts: { lint: "turbo run lint" },
            }
          : { ...fixtureManifest, scripts: { lint } };
        if (workspace) {
          writeFileSync(
            path.join(root, "packages/a/package.json"),
            JSON.stringify({ name: "@fixture/a", scripts: { lint } }),
          );
          trackedFiles.add("packages/a/package.json");
        }
        expect(checkNodeProjects({ root, manifest, trackedFiles })).toEqual([]);
      });
    }
  }
}, 15_000);

test("real inventory flags a source selected only by an npm prelint alias", () => {
  for (const [manager, version, runsHooks] of [
    ["npm", "12.2.0", true],
    ["bun", "1.4.3", true],
    ["pnpm", "12.9.1", true],
    ["yarn", "4.11.0", false],
  ] as const) {
    withInventoryFixture((root, trackedFiles) => {
      const manifest = {
        ...fixtureManifest,
        packageManager: `${manager}@${version}`,
        scripts: {
          lint: `${manager} run lint:core`,
          "prelint:core": "oxlint --config .oxlintrc.json scripts/pre-only.mjs",
          "lint:core": "oxlint --config .oxlintrc.json scripts/owned.mjs",
        },
      };
      for (const file of ["scripts/owned.mjs", "scripts/pre-only.mjs"]) {
        writeFileSync(path.join(root, file), "export const value = 1;\n");
        trackedFiles.add(file);
      }
      writeFileSync(
        path.join(root, "scripts/tsconfig.json"),
        JSON.stringify({
          compilerOptions: { allowJs: true },
          files: ["owned.mjs"],
        }),
      );
      trackedFiles.add("scripts/tsconfig.json");
      expect(
        checkNodeProjects({ root, manifest, trackedFiles }).map(
          ({ path: file }) => file,
        ),
        manager,
      ).toEqual(runsHooks ? ["scripts/pre-only.mjs"] : []);
      if (manager === "npm" || manager === "pnpm") {
        const config = manager === "npm" ? ".npmrc" : "pnpm-workspace.yaml";
        const source =
          manager === "npm"
            ? "ignore-scripts=true\n"
            : "enablePrePostScripts: false\n";
        writeFileSync(path.join(root, config), source);
        trackedFiles.add(config);
        expect(checkNodeProjects({ root, manifest, trackedFiles })).toEqual([]);
      }
    });
  }
}, 15_000);

test("workspace hooks use the root manager and unresolved pnpm configuration fails closed", () => {
  withInventoryFixture((root, trackedFiles) => {
    const manifest = {
      ...fixtureManifest,
      packageManager: "pnpm@12.9.1",
      workspaces: ["packages/*"],
      scripts: { lint: "turbo run lint" },
    };
    mkdirSync(path.join(root, "packages/a"), { recursive: true });
    const files = {
      "packages/a/package.json": JSON.stringify({
        name: "@fixture/a",
        scripts: { prelint: "oxlint orphan.mjs", lint: "oxlint owned.mjs" },
      }),
      "packages/a/owned.mjs": "export const value = 1;\n",
      "packages/a/orphan.mjs": "export const value = 1;\n",
      "packages/a/tsconfig.json": JSON.stringify({
        compilerOptions: { allowJs: true },
        files: ["owned.mjs"],
      }),
    };
    for (const [file, source] of Object.entries(files)) {
      writeFileSync(path.join(root, file), source);
      trackedFiles.add(file);
    }
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages: ['packages/*']\n",
    );
    trackedFiles.add("pnpm-workspace.yaml");
    expect(
      checkNodeProjects({ root, manifest, trackedFiles }).map(
        ({ path: file }) => file,
      ),
    ).toEqual(["packages/a/orphan.mjs"]);
    trackedFiles.delete("pnpm-workspace.yaml");
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages: ['packages/*']\nenablePrePostScripts: false\n",
    );
    const untracked = checkNodeProjects({ root, manifest, trackedFiles });
    expect(untracked).toHaveLength(1);
    expect(untracked.at(0)?.message).toContain("tracked regular");
    trackedFiles.add("pnpm-workspace.yaml");
    expect(checkNodeProjects({ root, manifest, trackedFiles })).toEqual([]);
  });
}, 15_000);

test("workspace lint tasks read pnpm-workspace.yaml membership and exclusions", () => {
  withInventoryFixture((root, trackedFiles) => {
    const manifest = {
      ...fixtureManifest,
      packageManager: "pnpm@12.9.1",
      scripts: { lint: "turbo run lint" },
    };
    const member = (name: string) => ({
      [`packages/${name}/package.json`]: JSON.stringify({
        name: `@fixture/${name}`,
        scripts: { lint: "oxlint ." },
      }),
      [`packages/${name}/owned.mjs`]: "export const value = 1;\n",
      [`packages/${name}/orphan.mjs`]: "export const value = 1;\n",
      [`packages/${name}/tsconfig.json`]: JSON.stringify({
        compilerOptions: { allowJs: true },
        files: ["owned.mjs"],
      }),
    });
    const files = {
      "pnpm-workspace.yaml":
        "packages:\n  - 'packages/*'\n  - '!packages/skipped'\n",
      ...member("a"),
      ...member("skipped"),
    };
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), source);
      trackedFiles.add(file);
    }
    expect(
      checkNodeProjects({ root, manifest, trackedFiles }).map(
        ({ path: file }) => file,
      ),
    ).toEqual(["packages/a/orphan.mjs"]);
    // Under Bun, package.json workspaces stay authoritative even when a
    // settings-only pnpm-workspace.yaml is tracked.
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
    expect(
      checkNodeProjects({
        root,
        manifest: {
          ...manifest,
          packageManager: "bun@1.4.3",
          workspaces: ["packages/*", "!packages/skipped"],
        },
        trackedFiles,
      }).map(({ path: file }) => file),
    ).toEqual(["packages/a/orphan.mjs"]);
  });
}, 15_000);

test("filtered Bun builds select package.json workspaces even under pnpm", () => {
  withInventoryFixture((root, trackedFiles) => {
    const manifest = {
      ...fixtureManifest,
      packageManager: "pnpm@12.9.1",
      workspaces: ["packages/bun-member"],
      scripts: { lint: "bun --filter @fixture/bun-member build" },
    };
    const member = (name: string) => ({
      [`packages/${name}/package.json`]: JSON.stringify({
        name: `@fixture/${name}`,
        private: true,
        scripts: { build: "oxlint orphan.mjs" },
      }),
      [`packages/${name}/orphan.mjs`]: "export const value = 1;\n",
      [`packages/${name}/tsconfig.json`]: JSON.stringify({
        compilerOptions: { allowJs: true },
        files: [],
      }),
    });
    const files = {
      "pnpm-workspace.yaml": "packages: ['packages/pnpm-member']\n",
      ...member("bun-member"),
      ...member("pnpm-member"),
    };
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), source);
      trackedFiles.add(file);
    }
    expect(
      checkNodeProjects({ root, manifest, trackedFiles }).map(
        ({ path: file }) => file,
      ),
    ).toEqual(["packages/bun-member/orphan.mjs"]);
    const pnpmOnly = checkNodeProjects({
      root,
      manifest: {
        ...manifest,
        scripts: { lint: "bun --filter @fixture/pnpm-member build" },
      },
      trackedFiles,
    });
    expect(new Set(pnpmOnly.map(({ path: file }) => file))).toEqual(
      new Set(["package.json"]),
    );
    expect(
      pnpmOnly.some(({ message }) =>
        message.includes("one declared workspace package"),
      ),
    ).toBe(true);
  });
}, 15_000);

test("a nearest project that owns no roots defers to its ancestor", () => {
  withInventoryFixture((root, trackedFiles) => {
    const manifest = {
      ...fixtureManifest,
      scripts: { lint: "oxlint scripts" },
    };
    const files = {
      "scripts/tsconfig.json": JSON.stringify({
        compilerOptions: { allowJs: true },
        include: ["**/*.mjs"],
      }),
      "scripts/nested/tsconfig.json": JSON.stringify({ files: [] }),
      "scripts/nested/owned.mjs": "export const value = 1;\n",
    };
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), source);
      trackedFiles.add(file);
    }
    expect(checkNodeProjects({ root, manifest, trackedFiles })).toEqual([]);
  });
}, 15_000);

test("filtered Bun build preparation cannot hide selected workspace lifecycle hooks", () => {
  withInventoryFixture((root, trackedFiles) => {
    const manifest = {
      ...fixtureManifest,
      packageManager: "bun@1.4.3",
      workspaces: ["packages/*"],
      scripts: {
        lint: "bun --filter @fixture/a build && oxlint scripts/owned.mjs",
      },
    };
    mkdirSync(path.join(root, "packages/a"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts/owned.mjs"),
      "export const value = 1;\n",
    );
    writeFileSync(
      path.join(root, "scripts/tsconfig.json"),
      JSON.stringify({
        compilerOptions: { allowJs: true },
        files: ["owned.mjs"],
      }),
    );
    for (const file of [
      "scripts/owned.mjs",
      "scripts/tsconfig.json",
      "packages/a/package.json",
    ])
      trackedFiles.add(file);
    const packageFile = path.join(root, "packages/a/package.json");
    const member = {
      name: "@fixture/a",
      private: true,
      scripts: { build: "echo prepared" },
    };
    writeFileSync(packageFile, JSON.stringify(member));
    expect(checkNodeProjects({ root, manifest, trackedFiles })).toEqual([]);
    expect(
      checkNodeProjects({
        root,
        manifest: {
          ...manifest,
          scripts: { lint: "bun --filter @fixture/a build" },
        },
        trackedFiles,
      }).map(({ path: file, message }) => [file, message]),
    ).toEqual([
      [
        "package.json",
        "root lint scripts contain no supported oxlint invocation",
      ],
    ]);
    writeFileSync(
      path.join(root, "packages/a/orphan.mjs"),
      "export const orphan = 1;\n",
    );
    trackedFiles.add("packages/a/orphan.mjs");
    for (const build of ["oxlint orphan.mjs", "bun run inspect"]) {
      writeFileSync(
        packageFile,
        JSON.stringify({
          ...member,
          scripts: { build, inspect: "oxlint orphan.mjs" },
        }),
      );
      expect(
        checkNodeProjects({ root, manifest, trackedFiles }).map(
          ({ path: file }) => file,
        ),
      ).toEqual(["packages/a/orphan.mjs"]);
    }
    expect(
      checkNodeProjects({
        root,
        manifest: {
          ...manifest,
          scripts: { lint: "bun --filter @fixture/a build" },
        },
        trackedFiles,
      }).map(({ path: file }) => file),
    ).toEqual(["packages/a/orphan.mjs"]);
    writeFileSync(
      packageFile,
      JSON.stringify({
        ...member,
        scripts: { build: "npm exec oxlint orphan.mjs" },
      }),
    );
    expect(
      checkNodeProjects({ root, manifest, trackedFiles }).at(0)?.message,
    ).toContain("unsupported or dynamic oxlint launcher");
    writeFileSync(
      packageFile,
      JSON.stringify({
        ...member,
        scripts: { build: "bun --filter @fixture/a build" },
      }),
    );
    expect(
      checkNodeProjects({ root, manifest, trackedFiles }).at(0)?.message,
    ).toContain("Cyclic filtered Bun build");
    for (const hook of ["prebuild", "postbuild"]) {
      writeFileSync(
        packageFile,
        JSON.stringify({
          ...member,
          scripts: { ...member.scripts, [hook]: "oxlint hidden.mjs" },
        }),
      );
      const diagnostics = checkNodeProjects({ root, manifest, trackedFiles });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics.at(0)?.message).toContain(
        "Filtered Bun build lifecycle hooks are unsupported",
      );
    }
    const unknown = checkNodeProjects({
      root,
      manifest: {
        ...manifest,
        scripts: {
          lint: "bun --filter '@fixture/*' build && oxlint scripts/owned.mjs",
        },
      },
      trackedFiles,
    });
    expect(unknown).toHaveLength(1);
    expect(unknown.at(0)?.message).toContain("one declared workspace package");
  });
}, 15_000);

test("nested workspace lifecycle settings cannot silently override root hook selection", () => {
  for (const lint of [
    "turbo run lint",
    "bun --filter @fixture/a build && oxlint packages/a/owned.mjs",
  ])
    withInventoryFixture((root, trackedFiles) => {
      const manifest = {
        ...fixtureManifest,
        packageManager: "pnpm@12.9.1",
        workspaces: ["packages/*"],
        scripts: { lint },
      };
      mkdirSync(path.join(root, "packages/a"), { recursive: true });
      const files = {
        "pnpm-workspace.yaml":
          "packages: ['packages/*']\nenablePrePostScripts: false\n",
        "packages/a/package.json": JSON.stringify({
          name: "@fixture/a",
          scripts: {
            build: "pnpm run lint",
            prelint: "oxlint orphan.mjs",
            lint: "oxlint owned.mjs",
          },
        }),
        "packages/a/owned.mjs": "export const value = 1;\n",
        "packages/a/orphan.mjs": "export const value = 1;\n",
        "packages/a/tsconfig.json": JSON.stringify({
          compilerOptions: { allowJs: true },
          files: ["owned.mjs"],
        }),
      };
      for (const [file, source] of Object.entries(files)) {
        writeFileSync(path.join(root, file), source);
        trackedFiles.add(file);
      }
      expect(checkNodeProjects({ root, manifest, trackedFiles })).toEqual([]);
      writeFileSync(
        path.join(root, "packages/a/pnpm-workspace.yaml"),
        "enablePrePostScripts: true\n",
      );
      trackedFiles.add("packages/a/pnpm-workspace.yaml");
      const findings = checkNodeProjects({ root, manifest, trackedFiles });
      expect(findings).toHaveLength(1);
      expect(findings.at(0)?.message).toContain("nested workspace overrides");
    });
}, 15_000);

test("declared inventory runtimes load real configs independently of the checker parent", async () => {
  const bundleRoot = mkdtempSync(path.join(tmpdir(), "stll-inventory-parent-"));
  try {
    const entry = path.join(bundleRoot, "entry.ts");
    writeFileSync(
      entry,
      `
      import { checkNodeProjects } from ${JSON.stringify(path.join(import.meta.dir, "toolchain-node-projects.ts"))};
      import { readFileSync } from "node:fs";
      const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
      console.log(JSON.stringify(checkNodeProjects({ ...input, trackedFiles: new Set(input.trackedFiles) })));
    `,
    );
    const build = await Bun.build({
      entrypoints: [entry],
      outdir: bundleRoot,
      naming: "checker.mjs",
      target: "node",
    });
    expect(build.success).toBe(true);
    withInventoryFixture((root, trackedFiles) => {
      writeFileSync(
        path.join(root, "scripts/owned.mjs"),
        "export const owned = true;\n",
      );
      writeFileSync(
        path.join(root, "scripts/orphan.mjs"),
        "export const orphan = true;\n",
      );
      writeFileSync(
        path.join(root, "scripts/tsconfig.json"),
        JSON.stringify({
          compilerOptions: { allowJs: true },
          files: ["owned.mjs"],
        }),
      );
      writeFileSync(
        path.join(root, "oxlint.shared.ts"),
        "export default {};\n",
      );
      writeFileSync(
        path.join(root, "oxlint.config.ts"),
        'import config from "./oxlint.shared"; export default config;\n',
      );
      for (const file of [
        "scripts/owned.mjs",
        "scripts/orphan.mjs",
        "scripts/tsconfig.json",
        "oxlint.shared.ts",
        "oxlint.config.ts",
      ])
        trackedFiles.add(file);
      for (const lint of [
        "bun --bun oxlint -c oxlint.config.ts --type-aware scripts",
        "oxlint -c .oxlintrc.json --type-aware scripts",
      ]) {
        const input = path.join(bundleRoot, "input.json");
        writeFileSync(
          input,
          JSON.stringify({
            root,
            manifest: { ...fixtureManifest, scripts: { lint } },
            trackedFiles: [...trackedFiles],
          }),
        );
        for (const parent of ["node", "bun"]) {
          const result = spawnSync(
            parent,
            [
              ...(parent === "bun" ? ["--bun"] : []),
              path.join(bundleRoot, "checker.mjs"),
              input,
            ],
            { encoding: "utf8" },
          );
          expect(result.status, result.stderr).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual([
            {
              rule: nodeProjectRule,
              path: "scripts/orphan.mjs",
              line: 1,
              message: expect.stringContaining("inferred project"),
            },
          ]);
        }
      }
    });
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
}, 15_000);
