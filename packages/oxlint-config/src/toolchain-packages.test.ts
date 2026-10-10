/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { stringify } from "yaml";

import { checkPackageFiles, packageRules } from "./toolchain-packages";

const policy = {
  bun: "1.4.3",
  packages: {
    oxlint: "1.87.0",
    lefthook: "2.0.0",
    "@stll/oxlint-plugin": "0.7.0",
  },
  node: "26.x",
  typescriptInstallLayouts: [
    {
      type: "direct",
      compilerPackage: "typescript",
      compilerSpecifier: "7.0.2",
      typecheckCommand: "tsc --noEmit",
    },
    {
      type: "split-compatibility",
      compilerPackage: "@typescript/native",
      compilerSpecifier: "npm:typescript@7.0.2",
      compatibilityPackage: "typescript",
      compatibilitySpecifier: "6.0.3",
      typecheckCommand:
        "node ./node_modules/@typescript/native/bin/tsc --noEmit",
    },
  ],
  typescript6Compatibility: {
    version: "6.0.3",
    packageAlias: "typescript-compat",
  },
} as const;
const json = (value: unknown) => JSON.stringify(value, null, 2);
const check = (files: Record<string, string>) =>
  checkPackageFiles({ files, policy });
const manifest = (value: unknown) => check({ "package.json": json(value) });

describe("shared package pins", () => {
  test("pnpm descendant catalogs require explicit package membership", () => {
    const files = {
      "pnpm-workspace.yaml": stringify({
        packages: ["**"],
        catalog: { oxlint: "1.87.0", "@stll/oxlint-plugin": "workspace:*" },
      }),
      "package.json": json({}),
      "packages/plugin/package.json": json({
        name: "@stll/oxlint-plugin",
        version: "0.7.0",
      }),
      "apps/deep/app/package.json": json({
        devDependencies: {
          oxlint: "catalog:",
          "@stll/oxlint-plugin": "catalog:",
        },
      }),
    };
    expect(check(files)).toEqual([]);
    expect(
      check({
        ...files,
        "pnpm-workspace.yaml": stringify({
          catalog: { oxlint: "1.87.0", "@stll/oxlint-plugin": "workspace:*" },
        }),
      }).some(({ path }) => path === "apps/deep/app/package.json"),
    ).toBe(true);
    expect(
      check({
        ...files,
        "packages/plugin/package.json": json({
          name: "@stll/oxlint-plugin",
          version: "0.6.0",
        }),
      }),
    ).not.toEqual([]);
  });
  test("omitted or empty pnpm package patterns include only the root package", () => {
    for (const packages of [undefined, []]) {
      const workspace = stringify({
        packages,
        catalog: { oxlint: "1.87.0" },
      });
      expect(
        check({
          "pnpm-workspace.yaml": workspace,
          "package.json": json({ devDependencies: { oxlint: "catalog:" } }),
        }),
      ).toEqual([]);
      expect(
        check({
          "pnpm-workspace.yaml": workspace,
          "apps/app/package.json": json({
            devDependencies: { oxlint: "catalog:" },
          }),
        }),
      ).toMatchObject([
        { path: "apps/app/package.json", rule: "package-pins" },
      ]);
    }
  });
  test("pnpm ownership prevents member JSON catalogs from shadowing workspace pins", () => {
    for (const reference of ["catalog:", "catalog:tools"]) {
      const member = json({
        catalog: { oxlint: "1.87.0" },
        catalogs: { tools: { oxlint: "1.87.0" } },
        devDependencies: { oxlint: reference },
      });
      const files = {
        "pnpm-workspace.yaml": stringify({
          packages: ["packages/*"],
          catalog: { oxlint: "1.87.0" },
          catalogs: { tools: { oxlint: "1.87.0" } },
        }),
        "packages/app/package.json": member,
      };
      expect(check(files)).toEqual([]);
      for (const workspace of [
        {
          packages: ["packages/*"],
          catalog: { oxlint: "1.86.0" },
          catalogs: { tools: { oxlint: "1.86.0" } },
        },
        { packages: ["packages/*"] },
        {
          packages: ["packages/*", "!packages/app"],
          catalog: { oxlint: "1.87.0" },
          catalogs: { tools: { oxlint: "1.87.0" } },
        },
      ]) {
        expect(
          check({ ...files, "pnpm-workspace.yaml": stringify(workspace) }).some(
            ({ path, rule }) =>
              path === "packages/app/package.json" && rule === "package-pins",
          ),
        ).toBe(true);
      }
    }
  });
  test("pnpm default and named catalogs resolve owned tool pins", () => {
    for (const reference of ["catalog:", "catalog:default", "catalog:tools"]) {
      const pins = {
        ...policy.packages,
        "bun-types": policy.bun,
        typescript: "7.0.2",
      };
      const workspace = {
        packages: ["packages/*"],
        catalog: pins,
        catalogs: { tools: pins },
      };
      const files = {
        "pnpm-workspace.yaml": stringify(workspace),
        "package.json": json({}),
        "packages/app/package.json": json({
          devDependencies: Object.fromEntries(
            Object.keys(pins).map((name) => [name, reference]),
          ),
        }),
      };
      expect(check(files)).toEqual([]);
      for (const name of Object.keys(pins)) {
        const divergent = { ...pins, [name]: "wrong" };
        expect(
          check({
            ...files,
            "pnpm-workspace.yaml": stringify({
              ...workspace,
              catalog: divergent,
              catalogs: { tools: divergent },
            }),
          }),
        ).not.toEqual([]);
      }
    }
  });
  test("unused pnpm catalog pins report their YAML source lines", () => {
    const text =
      "packages:\n  - packages/*\ncatalog:\n  oxlint: ^1.87.0\ncatalogs:\n  tools:\n    oxlint: ^1.87.0\n";
    expect(check({ "pnpm-workspace.yaml": text })).toMatchObject([
      { path: "pnpm-workspace.yaml", line: 4, rule: "package-pins" },
      { path: "pnpm-workspace.yaml", line: 7, rule: "package-pins" },
    ]);
  });
  test("pnpm catalog references fail missing, cyclic and excluded workspace resolution", () => {
    const consumer = json({ devDependencies: { oxlint: "catalog:" } });
    for (const catalog of [
      {},
      { oxlint: "catalog:missing" },
      { oxlint: "catalog:" },
      { oxlint: "catalog:tools" },
    ]) {
      expect(
        check({
          "pnpm-workspace.yaml": stringify({
            packages: ["packages/*"],
            catalog,
            catalogs: { tools: { oxlint: "catalog:" } },
          }),
          "packages/app/package.json": consumer,
        }),
      ).not.toEqual([]);
    }
    expect(
      check({
        "pnpm-workspace.yaml": stringify({
          packages: ["packages/*", "!packages/excluded"],
          catalog: { oxlint: "1.87.0" },
        }),
        "packages/excluded/package.json": consumer,
      }),
    ).toMatchObject([
      { path: "packages/excluded/package.json", rule: "package-pins" },
    ]);
    const files = {
      "pnpm-workspace.yaml": stringify({
        packages: ["nested/**"],
        catalog: { oxlint: "1.87.0" },
      }),
      "nested/pnpm-workspace.yaml": stringify({
        packages: ["app"],
        catalog: { oxlint: "1.87.0" },
      }),
      "nested/app/package.json": consumer,
    };
    expect(check(files)).toEqual([]);
    expect(
      check({
        ...files,
        "nested/pnpm-workspace.yaml": stringify({ packages: ["app"] }),
      }),
    ).toMatchObject([
      { path: "nested/app/package.json", rule: "package-pins" },
    ]);
  });
  test("pnpm workspace pins respect the workspace file instead of JSON workspaces", () => {
    const files = {
      "pnpm-workspace.yaml": stringify({
        packages: ["./packages/*"],
        catalog: { "@stll/oxlint-plugin": "workspace:*" },
      }),
      "package.json": json({ workspaces: ["other/*"] }),
      "packages/plugin/package.json": json({
        name: "@stll/oxlint-plugin",
        version: "0.7.0",
      }),
      "packages/app/package.json": json({
        devDependencies: { "@stll/oxlint-plugin": "catalog:" },
      }),
    };
    expect(check(files)).toEqual([]);
    expect(
      check({
        ...files,
        "pnpm-workspace.yaml": stringify({
          packages: ["packages/*", "!packages/plugin"],
          catalog: { "@stll/oxlint-plugin": "workspace:*" },
        }),
      }),
    ).not.toEqual([]);
  });
  test("invalid pnpm catalog documents fail instead of skipping pins", () => {
    for (const text of [
      "catalog: [",
      "[]",
      "null",
      "catalog: {}\ncatalog: {}\n",
      "catalog: []\n",
      "catalogs: []\n",
      "catalogs:\n  tools: []\n",
      "packages: other\n",
      "packages: [42]\n",
    ])
      expect(check({ "pnpm-workspace.yaml": text })).toMatchObject([
        { rule: "package-pins", path: "pnpm-workspace.yaml" },
      ]);
  });
  test("packageManager must name the exact shared Bun version", () => {
    expect(manifest({ packageManager: `bun@${policy.bun}` })).toEqual([]);
    for (const value of [
      "bun@1.4.1",
      "bun@^1.4.3",
      "npm@10.0.0",
      "pnpm@10.0.0",
      "bun@1.4.3+sha512.value",
      null,
      143,
    ])
      expect(manifest({ packageManager: value })).toMatchObject([
        { rule: "bun-pins", line: 2 },
      ]);
  });
  test("bun-types resolves recursive catalogs through the nearest workspace", () => {
    const files = {
      "package.json": json({
        workspaces: {
          packages: ["packages/*"],
          catalog: { "bun-types": "1.4.1" },
        },
      }),
      "packages/nested/package.json": json({
        workspaces: {
          packages: ["apps/*"],
          catalog: { "bun-types": "catalog:types" },
          catalogs: { types: { "bun-types": policy.bun } },
        },
      }),
      "packages/nested/apps/app/package.json": json({
        devDependencies: { "bun-types": "catalog:" },
      }),
    };
    const diagnostics = check(files);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      path: "package.json",
      rule: "bun-pins",
    });
    expect(
      check({
        ...files,
        "packages/nested/package.json": json({
          workspaces: {
            packages: ["apps/*"],
            catalog: { "bun-types": "catalog:" },
          },
        }),
      }).some(({ path }) => path === "packages/nested/apps/app/package.json"),
    ).toBe(true);
  });
  test("repeated bun-types declarations report each divergent line", () => {
    const diagnostics = manifest({
      dependencies: { "bun-types": "1.4.1" },
      devDependencies: { "bun-types": "1.4.1" },
      catalog: { "bun-types": "1.4.2" },
    });
    expect(diagnostics.map(({ line }) => line)).toEqual([3, 6, 9]);
    expect(diagnostics.every(({ rule }) => rule === "bun-pins")).toBe(true);
  });
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "catalog",
  ]) {
    for (const [name, version] of Object.entries({
      ...policy.packages,
      "bun-types": policy.bun,
    })) {
      test(`${section} ${name} accepts only the shared pin`, () => {
        expect(manifest({ [section]: { [name]: version } })).toEqual([]);
        for (const mutated of [
          `^${version}`,
          `~${version}`,
          "latest",
          "workspace:*",
          "1.0.0",
        ]) {
          const result = manifest({ [section]: { [name]: mutated } });
          expect(result).toHaveLength(1);
          expect(result[0]).toMatchObject({
            rule: name === "bun-types" ? "bun-pins" : "package-pins",
            path: "package.json",
            line: 3,
          });
        }
      });
    }
  }
  test("all catalog containers enforce pins independently of consumers", () => {
    for (const wrap of [
      (entry: unknown) => ({ catalogs: { tools: entry } }),
      (entry: unknown) => ({ workspaces: { catalog: entry } }),
      (entry: unknown) => ({ workspaces: { catalogs: { tools: entry } } }),
    ]) {
      expect(manifest(wrap({ oxlint: "1.87.0" }))).toEqual([]);
      expect(manifest(wrap({ oxlint: "^1.87.0" }))).toHaveLength(1);
    }
  });
  test("workspace pins require a matching repository package and version", () => {
    const consumer = json({
      workspaces: ["packages/*"],
      devDependencies: { "@stll/oxlint-plugin": "workspace:*" },
    });
    const files = {
      "package.json": consumer,
      "packages/plugin/package.json": json({
        name: "@stll/oxlint-plugin",
        version: "0.7.0",
      }),
    };
    expect(check(files)).toEqual([]);
    for (const version of ["0.6.0", "^0.7.0", undefined]) {
      expect(
        check({
          ...files,
          "packages/plugin/package.json": json({
            name: "@stll/oxlint-plugin",
            version,
          }),
        }),
      ).toHaveLength(1);
    }
  });
  test("workspace references cannot resolve undeclared, excluded or ambiguous packages", () => {
    const packageManifest = json({
      name: "@stll/oxlint-plugin",
      version: "0.7.0",
    });
    for (const workspaces of [
      undefined,
      ["apps/*"],
      ["packages/*", "!packages/plugin"],
      { packages: ["apps/*"] },
    ]) {
      expect(
        check({
          "package.json": json({
            workspaces,
            devDependencies: { "@stll/oxlint-plugin": "workspace:*" },
          }),
          "packages/plugin/package.json": packageManifest,
        }),
      ).toHaveLength(1);
    }
    for (const version of ["0.7.0", "0.6.0"]) {
      expect(
        check({
          "package.json": json({
            workspaces: ["packages/*"],
            devDependencies: { "@stll/oxlint-plugin": "workspace:*" },
          }),
          "packages/plugin/package.json": packageManifest,
          "packages/duplicate/package.json": json({
            name: "@stll/oxlint-plugin",
            version,
          }),
        }),
      ).toHaveLength(1);
    }
    expect(
      check({
        "package.json": json({ workspaces: { packages: ["packages/**"] } }),
        "packages/plugin/package.json": packageManifest,
        "packages/app/nested/package.json": json({
          devDependencies: { "@stll/oxlint-plugin": "workspace:*" },
        }),
      }),
    ).toEqual([]);
  });
  test("workspace pins require consumer membership for every owned dependency section", () => {
    const patterns = ["./packages/*", "!./packages/excluded"];
    for (const workspaces of [patterns, { packages: patterns }]) {
      for (const section of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
      ]) {
        for (const [name, version] of Object.entries({
          ...policy.packages,
          "bun-types": policy.bun,
        })) {
          const base = {
            "package.json": json({ workspaces }),
            "packages/producer/package.json": json({ name, version }),
          };
          const consumer = json({ [section]: { [name]: "workspace:*" } });
          for (const file of ["package.json", "packages/member/package.json"])
            expect(
              check({
                ...base,
                [file]:
                  file === "package.json"
                    ? json({ workspaces, [section]: { [name]: "workspace:*" } })
                    : consumer,
              }),
            ).toEqual([]);
          for (const file of [
            "standalone/package.json",
            "packages/excluded/package.json",
          ])
            expect(check({ ...base, [file]: consumer })).toMatchObject([
              {
                path: file,
                rule: name === "bun-types" ? "bun-pins" : "package-pins",
                message: `${name} workspace:* consumer is not a member of its nearest workspace`,
              },
            ]);
        }
      }
    }
  });
  test("catalog workspace pins retain the consuming package membership check", () => {
    for (const workspaces of [
      ["packages/*", "!packages/excluded"],
      { packages: ["packages/*", "!packages/excluded"] },
    ]) {
      for (const catalog of ["catalog:", "catalog:tools"]) {
        const base = {
          "package.json": json({
            workspaces,
            catalog: { "@stll/oxlint-plugin": "workspace:*" },
            catalogs: { tools: { "@stll/oxlint-plugin": "workspace:*" } },
          }),
          "packages/plugin/package.json": json({
            name: "@stll/oxlint-plugin",
            version: "0.7.0",
          }),
        };
        for (const [directory, member] of [
          ["packages/app", true],
          ["packages/excluded", false],
          ["standalone", false],
        ] as const) {
          const file = `${directory}/package.json`;
          const diagnostics = check({
            ...base,
            [file]: json({ dependencies: { "@stll/oxlint-plugin": catalog } }),
          });
          if (member) expect(diagnostics).toEqual([]);
          else
            expect(diagnostics).toMatchObject([
              {
                path: file,
                message:
                  "@stll/oxlint-plugin workspace:* consumer is not a member of its nearest workspace",
              },
            ]);
        }
      }
    }
  });
  test("nearest workspace boundaries and package-manifest producers cannot be bypassed", () => {
    expect(
      check({
        "package.json": json({
          name: "@stll/oxlint-plugin",
          version: "0.7.0",
          workspaces: ["packages/*"],
        }),
        "packages/member/package.json": json({
          dependencies: { "@stll/oxlint-plugin": "workspace:*" },
        }),
      }),
    ).toMatchObject([
      { message: "@stll/oxlint-plugin must be 0.7.0, found workspace:*" },
    ]);
    const base = {
      "package.json": json({ workspaces: ["packages/**"] }),
      "packages/plugin/package.json": json({
        name: "@stll/oxlint-plugin",
        version: "0.7.0",
      }),
      "packages/nested/package.json": json({
        workspaces: { packages: ["apps/*", "!apps/excluded"] },
      }),
    };
    const consumer = json({
      dependencies: { "@stll/oxlint-plugin": "workspace:*" },
    });
    expect(
      check({ ...base, "packages/nested/apps/member/package.json": consumer }),
    ).toMatchObject([
      {
        message: "@stll/oxlint-plugin must be 0.7.0, found workspace:*",
      },
    ]);
    expect(
      check({
        ...base,
        "packages/nested/apps/excluded/package.json": consumer,
      }),
    ).toMatchObject([
      {
        message:
          "@stll/oxlint-plugin workspace:* consumer is not a member of its nearest workspace",
      },
    ]);
    expect(
      check({
        ...base,
        "packages/nested/apps/plugin/package.json": json({
          name: "@stll/oxlint-plugin",
          version: "0.7.0",
        }),
        "packages/nested/apps/member/package.json": consumer,
      }),
    ).toEqual([]);
    expect(
      check({
        "package.json": json({
          workspaces: ["packages/*"],
          dependencies: { "@stll/oxlint-plugin": "workspace:*" },
        }),
        "packages/impostor/pnpm-workspace.yaml": stringify({
          name: "@stll/oxlint-plugin",
          version: "0.7.0",
        }),
      }),
    ).toMatchObject([
      { message: "@stll/oxlint-plugin must be 0.7.0, found workspace:*" },
    ]);
  });
  test("catalog links resolve default, named and chained catalogs", () => {
    for (const workspaces of [false, true]) {
      const catalogs = {
        catalog: { oxlint: "catalog:tools" },
        catalogs: { tools: { oxlint: "1.87.0" } },
      };
      const root = workspaces ? { workspaces: catalogs } : catalogs;
      const files = {
        "package.json": json(root),
        "packages/app/package.json": json({
          devDependencies: { oxlint: "catalog:" },
        }),
      };
      expect(check(files)).toEqual([]);
      expect(
        check({
          ...files,
          "package.json": json(
            workspaces
              ? {
                  workspaces: {
                    ...catalogs,
                    catalogs: { tools: { oxlint: "1.86.0" } },
                  },
                }
              : { ...catalogs, catalogs: { tools: { oxlint: "1.86.0" } } },
          ),
        }),
      ).not.toEqual([]);
    }
  });
  test("missing catalog entries, cycles and nearest workspace shadowing fail", () => {
    for (const catalogs of [
      {},
      { catalog: {} },
      { catalog: { oxlint: "catalog:" } },
      {
        catalog: { oxlint: "catalog:tools" },
        catalogs: { tools: { oxlint: "catalog:" } },
      },
    ]) {
      expect(
        check({
          "package.json": json(catalogs),
          "app/package.json": json({ devDependencies: { oxlint: "catalog:" } }),
        }),
      ).not.toEqual([]);
    }
    const files = {
      "package.json": json({ catalog: { oxlint: "1.87.0" } }),
      "nested/package.json": json({
        workspaces: { packages: ["app"], catalog: { oxlint: "1.86.0" } },
      }),
      "nested/app/package.json": json({
        devDependencies: { oxlint: "catalog:" },
      }),
    };
    expect(
      check(files).some(({ path }) => path === "nested/app/package.json"),
    ).toBe(true);
    expect(
      check({ ...files, "nested/package.json": json({ workspaces: ["app"] }) }),
    ).not.toEqual([]);
  });
  test("unowned dependencies and absent tools do not fail", () => {
    expect(
      manifest({ dependencies: { other: "^1", typescriptish: "^6" } }),
    ).toEqual([]);
    expect(check({ "README.md": "typescript 6" })).toEqual([]);
  });
  test("invalid manifest cannot silently skip checks", () => {
    for (const text of ["{", "[]", "null", "42"])
      expect(check({ "package.json": text })).toHaveLength(1);
  });
});

describe("TypeScript install layouts", () => {
  test("split compiler scripts select the declared current compiler", () => {
    const dependencies = {
      "@typescript/native": "npm:typescript@7.0.2",
      typescript: "6.0.3",
    };
    const expected = "node ./node_modules/@typescript/native/bin/tsc --noEmit";
    for (const typecheck of [
      expected,
      `${expected} --pretty false`,
      `bun run prepare && ${expected}`,
    ])
      expect(manifest({ dependencies, scripts: { typecheck } })).toEqual([]);
    for (const typecheck of [
      "tsc --noEmit",
      "tsgo --noEmit",
      "bun check",
      "bunx tsc --noEmit",
      "npx tsc --noEmit",
      "bun run tsc --noEmit",
      "node ./node_modules/typescript/bin/tsc --noEmit",
      `${expected} && tsc --noEmit`,
      `tsc --noEmit || ${expected}`,
    ])
      expect(
        manifest({ dependencies, scripts: { typecheck } }).some(
          ({ rule }) => rule === "typescript-layout",
        ),
      ).toBe(true);
  });
  test("direct compiler scripts keep the policy invocation", () => {
    const dependencies = { typescript: "7.0.2" };
    expect(
      manifest({
        dependencies,
        scripts: { typecheck: "tsc --noEmit --pretty false" },
      }),
    ).toEqual([]);
    expect(
      manifest({
        dependencies,
        scripts: { typecheck: "tsc --emitDeclarationOnly" },
      }),
    ).not.toEqual([]);
    expect(
      manifest({
        dependencies,
        scripts: { typecheck: "bun --filter app typecheck" },
      }),
    ).toEqual([]);
    expect(
      manifest({
        dependencies,
        scripts: { typecheck: "bun scripts/typecheck.ts" },
      }),
    ).toEqual([]);
  });
  test("environment prefixes preserve direct compiler selection in every segment", () => {
    const dependencies = {
      "@typescript/native": "npm:typescript@7.0.2",
      typescript: "6.0.3",
    };
    const expected = "node ./node_modules/@typescript/native/bin/tsc --noEmit";
    const prefixes = [
      "NODE_OPTIONS=--max-old-space-size=4096",
      'NODE_OPTIONS="--max-old-space-size=4096 --trace-warnings" CI=1',
      "LABEL='tsc; ignored && tsgo | ignored' CI=",
      "LABEL=escaped\\ value",
      "env",
      "env NODE_OPTIONS=--max-old-space-size=4096",
      "CI=1 env NODE_OPTIONS='--trace-warnings --trace-deprecation'",
      "/usr/bin/env -i CI=1",
      "env --ignore-environment --unset NODE_OPTIONS CI=1",
      "env -u NODE_OPTIONS --unset=CI -uDEBUG -- CI=1",
      "env CI=1 env NODE_OPTIONS=--trace-warnings",
    ];
    for (const prefix of prefixes) {
      for (const command of [expected, `${expected} --pretty false`])
        expect(
          manifest({
            dependencies,
            scripts: { typecheck: `${prefix} ${command}` },
          }),
        ).toEqual([]);
      for (const compiler of [
        "tsc --noEmit",
        "./node_modules/.bin/tsc --noEmit",
        "node ./node_modules/typescript/bin/tsc --noEmit",
        "bunx tsc --noEmit",
      ]) {
        for (const typecheck of [
          `${prefix} ${compiler}`,
          `bun run prepare && ${prefix} ${compiler}`,
          `${expected} || ${prefix} ${compiler}`,
          `${expected}; ${prefix} ${compiler}`,
        ])
          expect(
            manifest({ dependencies, scripts: { typecheck } }),
          ).toMatchObject([{ rule: "typescript-layout" }]);
      }
      for (const delegated of [
        "bun scripts/typecheck.ts",
        "bun --filter app typecheck",
        "node scripts/typecheck.js",
      ])
        expect(
          manifest({
            dependencies,
            scripts: { typecheck: `${prefix} ${delegated}` },
          }),
        ).toEqual([]);
    }
    expect(
      manifest({
        dependencies: { typescript: "7.0.2" },
        scripts: {
          typecheck: "env NODE_OPTIONS=--trace-warnings tsc --noEmit",
        },
      }),
    ).toEqual([]);
    expect(
      manifest({
        dependencies: { typescript: "7.0.2" },
        scripts: { typecheck: "NODE_OPTIONS= tsc --emitDeclarationOnly" },
      }).some(({ rule }) => rule === "typescript-layout"),
    ).toBe(true);
  });
  test("split layout rejects direct compiler paths in each shell segment", () => {
    const dependencies = {
      "@typescript/native": "npm:typescript@7.0.2",
      typescript: "6.0.3",
    };
    const expected = "node ./node_modules/@typescript/native/bin/tsc --noEmit";
    for (const executable of [
      "./node_modules/.bin/tsc",
      "node_modules/.bin/tsc",
      "../node_modules/.bin/tsc",
      "./node_modules/typescript/bin/tsc",
      "./node_modules/typescript/bin/tsc.js",
      "./node_modules/.bin/tsgo",
    ]) {
      for (const typecheck of [
        `${executable} --noEmit`,
        `bun run prepare && ${executable} --noEmit`,
        `${expected} && ${executable} --noEmit`,
        `${executable} --noEmit || ${expected}`,
      ]) {
        expect(
          manifest({ dependencies, scripts: { typecheck } }),
        ).toMatchObject([
          {
            rule: "typescript-layout",
            message: `typecheck compiler invocation must use ${expected}`,
          },
        ]);
      }
    }
  });
  test("launcher flags cannot conceal a compiler or broaden the declared command", () => {
    const dependencies = {
      "@typescript/native": "npm:typescript@7.0.2",
      typescript: "6.0.3",
    };
    const expected = "node ./node_modules/@typescript/native/bin/tsc --noEmit";
    for (const invocation of [
      "npx -y tsc --noEmit",
      "npx --yes --package typescript tsc --noEmit",
      "bunx --bun tsc --noEmit",
      "pnpm --filter app exec tsc --noEmit",
      "pnpm dlx --package=typescript tsc --noEmit",
      "pnpm -r tsc --noEmit",
      "pnpm exec -r tsc --noEmit",
      "pnpm dlx -c tsc --noEmit",
      "pnpm -c tsc --noEmit",
      "yarn --cwd packages/app tsc --noEmit",
      "yarn run -- tsc --noEmit",
      "bun x --bun tsc --noEmit",
      "bun --cwd packages/app run tsc --noEmit",
      "node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc --noEmit",
      "node --max-old-space-size 4096 ./node_modules/typescript/bin/tsc --noEmit",
      "node --require ./bootstrap.js ./node_modules/typescript/bin/tsc --noEmit",
      "node --require ./node_modules/typescript/bin/tsc --noEmit",
      "node --import ./node_modules/@typescript/native/bin/tsc.js --noEmit",
      "custom-launcher --flag tsc --noEmit",
      "unknown-launcher ./node_modules/typescript/bin/tsc --noEmit",
      "unknown-launcher bun check",
      "unknown-launcher bun --cwd . check",
      "unknown-launcher bun --bun check",
      'npx -y "tsc" --noEmit',
      'npx -y t"sc" --noEmit',
      "npx -y 't'\"sc\" --noEmit",
      "node ./node_modules/typescript/bin/t\\sc --noEmit",
      "node --max-old-space-size=4096 ./node_modules/@typescript/native/bin/tsc --noEmit",
      "node -e 'process.exit(0)' ./node_modules/@typescript/native/bin/tsc --noEmit",
      "node --require ./bootstrap.js ./node_modules/@typescript/native/bin/tsc --noEmit",
      "bun --cwd . check",
    ]) {
      for (const typecheck of [
        invocation,
        `NODE_OPTIONS=--trace-warnings ${invocation}`,
        `env CI=1 ${invocation}`,
        `${expected} && ${invocation}`,
        `${expected} || ${invocation}`,
        `${expected}; ${invocation}`,
        `${expected} | ${invocation}`,
      ])
        expect(
          manifest({ dependencies, scripts: { typecheck } }),
        ).toMatchObject([{ rule: "typescript-layout" }]);
    }
    for (const typecheck of [
      expected,
      `env NODE_OPTIONS=--trace-warnings ${expected}`,
      "node --max-old-space-size=4096 scripts/typecheck.js",
      "node --require ./bootstrap.js scripts/typecheck.js",
      "node -e 'process.exit(0)'",
      "node -p 'process.version'",
      "npx -c 'echo delegated'",
      "bun --filter tsc typecheck",
      "pnpm --filter tsc exec node scripts/typecheck.js",
      "npx --package tsc node scripts/typecheck.js",
      "bun --cwd packages/app scripts/typecheck.ts",
      "custom-launcher scripts/typecheck.ts",
    ])
      expect(manifest({ dependencies, scripts: { typecheck } })).toEqual([]);
    for (const typecheck of ["tsc --noEmit", "env CI=1 tsc --noEmit"])
      expect(
        manifest({
          dependencies: { typescript: "7.0.2" },
          scripts: { typecheck },
        }),
      ).toEqual([]);
    expect(
      manifest({
        dependencies: { typescript: "7.0.2" },
        scripts: { typecheck: "npx -y tsc --noEmit" },
      }),
    ).toMatchObject([{ rule: "typescript-layout" }]);
  });
  test("a Bun check layout validates its direct compiler command", () => {
    const selectedPolicy = {
      ...policy,
      typescriptInstallLayouts: policy.typescriptInstallLayouts.map(
        (layout) => ({ ...layout, typecheckCommand: "bun check" }),
      ),
    };
    for (const command of ["bun check", "bun check --project tsconfig.json"])
      expect(
        checkPackageFiles({
          files: {
            "package.json": json({
              devDependencies: { typescript: "7.0.2" },
              scripts: { typecheck: command },
            }),
          },
          policy: selectedPolicy,
        }),
      ).toEqual([]);
    expect(
      checkPackageFiles({
        files: {
          "package.json": json({
            devDependencies: { typescript: "7.0.2" },
            scripts: { typecheck: "tsc --noEmit" },
          }),
        },
        policy: selectedPolicy,
      }).some(({ rule }) => rule === "typescript-layout"),
    ).toBe(true);
  });
  test("all declared layouts pass and every required pin mutation fails", () => {
    for (const layout of policy.typescriptInstallLayouts) {
      const dependencies =
        layout.type === "direct"
          ? { [layout.compilerPackage]: layout.compilerSpecifier }
          : {
              [layout.compilerPackage]: layout.compilerSpecifier,
              [layout.compatibilityPackage]: layout.compatibilitySpecifier,
            };
      expect(manifest({ devDependencies: dependencies })).toEqual([]);
      for (const name of Object.keys(dependencies)) {
        expect(
          manifest({
            devDependencies: { ...dependencies, [name]: "^6.0.3" },
          }).some(({ rule }) => rule === "typescript-layout"),
        ).toBe(true);
      }
    }
  });
  test("split compatibility requires both packages and rejects mixed layouts", () => {
    for (const dependencies of [
      { typescript: "6.0.3" },
      { "@typescript/native": "npm:typescript@7.0.2" },
      { "@typescript/native": "npm:typescript@7.0.2", typescript: "7.0.2" },
    ])
      expect(manifest({ dependencies })).not.toEqual([]);
  });
  test("compatibility alias is exact and may accompany either layout", () => {
    expect(
      manifest({
        devDependencies: {
          typescript: "7.0.2",
          "typescript-compat": "npm:typescript@6.0.3",
        },
      }),
    ).toEqual([]);
    for (const value of ["6.0.3", "npm:typescript@^6.0.3", "npm:other@6.0.3"])
      expect(
        manifest({ dependencies: { "typescript-compat": value } }),
      ).toHaveLength(1);
  });
  test("catalogs resolve the entire split layout", () => {
    const catalogs = {
      typescript: "6.0.3",
      "@typescript/native": "npm:typescript@7.0.2",
    };
    const files = {
      "package.json": json({ workspaces: { catalog: catalogs } }),
      "app/package.json": json({
        devDependencies: {
          typescript: "catalog:",
          "@typescript/native": "catalog:",
        },
      }),
    };
    expect(check(files)).toEqual([]);
    expect(
      check({
        ...files,
        "app/package.json": json({
          devDependencies: { typescript: "catalog:" },
        }),
      }),
    ).not.toEqual([]);
  });
});

test("node engine support ranges must include the shared runtime", () => {
  for (const value of [policy.node, ">=26", "^26", "26", "^24 || >=26", "*"])
    expect(manifest({ engines: { node: value } })).toEqual([]);
  expect(manifest({ engines: { bun: ">=1" } })).toEqual([]);
  for (const value of [">=26.1.0", "^24", "24", "24.15.0", "invalid", null, 22])
    expect(manifest({ engines: { node: value } })).toMatchObject([
      { rule: "node-engine", line: 3 },
    ]);
});

test("node engine ranges must contain the entire selected major series", () => {
  const selectedPolicy = { ...policy, node: "26.x" };
  const engine = (node: unknown) =>
    checkPackageFiles({
      files: { "package.json": json({ engines: { node } }) },
      policy: selectedPolicy,
    });
  for (const range of [
    "26",
    "26.x",
    "^26",
    ">=26",
    "24 || 26",
    "*",
    ">=26 <27",
  ])
    expect(engine(range)).toEqual([]);
  for (const range of [
    "24",
    "^24",
    "<26",
    ">=27",
    "26.1",
    "^26.1.0",
    "26.0.0",
    ">=26 <26.5 || >=26.6 <27",
    "invalid",
    null,
    26,
  ])
    expect(engine(range)).toMatchObject([{ rule: "node-engine" }]);
  expect(
    checkPackageFiles({
      files: { "package.json": json({}) },
      policy: selectedPolicy,
    }),
  ).toEqual([]);
});

test("every exported rule has a failing hermetic fixture", () => {
  const detected = new Set(
    [
      ...manifest({ dependencies: { oxlint: "wrong" } }),
      ...manifest({ packageManager: "bun@wrong" }),
      ...manifest({ dependencies: { typescript: "wrong" } }),
      ...manifest({ engines: { node: "wrong" } }),
    ].map(({ rule }) => rule),
  );
  expect([...detected].sort()).toEqual([...packageRules].sort());
});
