import { describe, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

import policy from "../toolchain.json";
import {
  consumerCommandEnvironment,
  consumerReservedToolBins,
  assertConsumerFixtureFiles,
  consumerFixtureCommands,
  verifyConsumerNodeArchive,
  writeConsumerToolWrappers,
  runConsumerCompat,
  stageConsumerWorkspace,
  assertConsumerInstalledToolBins,
} from "./consumer-compat";
import { parseConsumerCompatArguments } from "./consumer-compat-arguments";
import {
  consumerRecord,
  consumerPackageClosure,
  consumerPublishedDependencyFields,
  consumerBundledDependencyFields,
  assertConsumerPublishableManifest,
  consumerStagingPaths,
  consumerPackRootManifest,
  bindConsumerManifest,
  discoverConsumerManifests,
  discoverConsumerPackages,
  oldestPublishedConsumerVersion,
  parseConsumerFixtures,
  type ConsumerFixture,
  assertConsumerFixtureKind,
  assertConsumerFixtureSelection,
} from "./consumer-compat-config";

describe("consumer compatibility declarations", () => {
  test("selected and declared consumer fixture sets must agree in both directions", () => {
    const fixtures = parseConsumerFixtures({
      packages: ["packages/a", "packages/b"].map((directory) => ({
        package: directory,
        fixture: directory,
        kind: "node",
        build: ["npm", "run", "build"],
        smoke: ["node", "smoke.mjs"],
      })),
    });
    expect(() =>
      assertConsumerFixtureSelection({
        selected: ["packages/b", "packages/a"],
        fixtures,
      }),
    ).not.toThrow();
    for (const selected of [
      ["packages/a"],
      ["packages/a", "packages/b", "packages/c"],
      ["packages/a", "packages/c"],
    ])
      expect(() =>
        assertConsumerFixtureSelection({ selected, fixtures }),
      ).toThrow("exactly match");
  });
  test("a private workspace root stages its manifest without copying unrelated root files", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "consumer-private-root-"),
    );
    try {
      const root = path.join(directory, "source");
      const staging = path.join(directory, "stage");
      await mkdir(path.join(root, "packages/library"), { recursive: true });
      await mkdir(staging);
      await writeFile(path.join(root, "root-only.txt"), "unrelated root file");
      await writeFile(
        path.join(root, "packages/library/index.js"),
        "export {};\n",
      );
      const packages = new Map([
        ["root", { directory: ".", name: "root", manifest: { private: true } }],
        [
          "library",
          {
            directory: "packages/library",
            name: "library",
            manifest: { private: false },
          },
        ],
      ]);
      await stageConsumerWorkspace({
        files: {},
        root: await realpath(root),
        staging,
        packages,
      });
      expect((await readdir(staging)).toSorted()).toEqual([
        "package.json",
        "packages",
        "pnpm-workspace.yaml",
      ]);
      expect(
        JSON.parse(await readFile(path.join(staging, "package.json"), "utf8")),
      ).toEqual({ private: true });
      expect(
        await readFile(path.join(staging, "packages/library/index.js"), "utf8"),
      ).toBe("export {};\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("staging preserves default and named catalogs for real publication without copying unrelated config", async () => {
    const require = createRequire(import.meta.url);
    const metadata: unknown = JSON.parse(
      await readFile(require.resolve("pnpm/package.json"), "utf8"),
    );
    if (
      !consumerRecord(metadata) ||
      metadata["version"] !== policy.consumerPnpm ||
      !consumerRecord(metadata["bin"]) ||
      typeof metadata["bin"]["pnpm"] !== "string"
    )
      throw new Error("installed pnpm must match consumer policy");
    const executable = path.resolve(
      path.dirname(require.resolve("pnpm/package.json")),
      metadata["bin"]["pnpm"],
    );
    for (const source of ["pnpm", "bun"] as const) {
      const directory = await mkdtemp(
        path.join(tmpdir(), "consumer-catalog-staging-"),
      );
      try {
        const root = path.join(directory, "source");
        const staging = path.join(directory, "stage");
        await mkdir(staging, { recursive: true });
        const defaultCatalog = { react: "18.3.1" };
        const namedCatalog = { compiler: { typescript: "6.0.3" } };
        const nestedCatalog = { react: "19.2.0" };
        const packages = new Map([
          [
            "root",
            {
              directory: ".",
              name: "root",
              manifest: {
                private: true,
                workspaces:
                  source === "bun"
                    ? {
                        packages: ["packages/*"],
                        catalog: defaultCatalog,
                        catalogs: namedCatalog,
                      }
                    : ["packages/*"],
              },
            },
          ],
          [
            "library",
            {
              directory: "packages/library",
              name: "library",
              manifest: {
                name: "library",
                version: "1.0.0",
                files: ["index.js", "vendor"],
                dependencies: {
                  react: "catalog:",
                  typescript: "catalog:compiler",
                },
              },
            },
          ],
          [
            "owner",
            {
              directory: "packages/owner",
              name: "owner",
              manifest: {
                private: true,
                workspaces:
                  source === "bun"
                    ? { packages: ["children/*"], catalog: nestedCatalog }
                    : ["children/*"],
              },
            },
          ],
          [
            "child",
            {
              directory: "packages/owner/children/child",
              name: "child",
              manifest: {
                name: "child",
                version: "1.0.0",
                files: ["index.js", "vendor"],
                dependencies: { react: "catalog:" },
              },
            },
          ],
        ]);
        const files: Record<string, string> =
          source === "pnpm"
            ? {
                "pnpm-workspace.yaml": stringify({
                  packages: ["packages/*"],
                  catalog: defaultCatalog,
                  catalogs: namedCatalog,
                  overrides: { react: "0.0.0" },
                }),
                "packages/owner/pnpm-workspace.yaml": stringify({
                  packages: ["children/*"],
                  catalog: nestedCatalog,
                  onlyBuiltDependencies: ["unrelated"],
                }),
              }
            : {};
        const sourceRoot = packages.get("root");
        if (sourceRoot === undefined) throw new Error("missing root fixture");
        files["package.json"] = JSON.stringify(sourceRoot.manifest);
        for (const pkg of packages.values()) {
          if (pkg.directory !== ".")
            files[`${pkg.directory}/package.json`] = JSON.stringify(
              pkg.manifest,
            );
        }
        const owners = discoverConsumerManifests(files);
        expect(owners.get(".")).toEqual(sourceRoot.manifest);
        expect(owners.get("packages/owner")?.["private"]).toBe(true);
        const namedOwners = discoverConsumerPackages({
          ...files,
          "package.json": JSON.stringify({
            ...sourceRoot.manifest,
            name: "root",
          }),
          "packages/owner/package.json": JSON.stringify({
            ...owners.get("packages/owner"),
            name: "owner",
          }),
        });
        expect(namedOwners.get("root")?.manifest["private"]).toBe(true);
        expect(namedOwners.get("owner")?.manifest["private"]).toBe(true);
        const discovered = discoverConsumerPackages(files);
        expect(
          [...discovered.values()].some((pkg) => pkg.directory === "."),
        ).toBe(false);
        expect(
          [...discovered.values()].some(
            (pkg) => pkg.directory === "packages/owner",
          ),
        ).toBe(false);
        for (const pkg of packages.values()) {
          const location = path.join(root, pkg.directory);
          await mkdir(location, { recursive: true });
          await writeFile(
            path.join(location, "package.json"),
            JSON.stringify(pkg.manifest),
          );
          await writeFile(path.join(location, "index.js"), "export {};\n");
          if (pkg.manifest["private"] !== true) {
            await mkdir(path.join(location, "vendor"));
            await writeFile(
              path.join(location, "vendor/runtime.js"),
              "export const vendored = true;\n",
            );
          }
        }
        for (const [file, text] of Object.entries(files))
          await writeFile(path.join(root, file), text);
        // Untracked workspace metadata is outside the captured source snapshot.
        await writeFile(
          path.join(root, "packages/library/pnpm-workspace.yaml"),
          stringify({ catalog: { react: "0.0.0" } }),
        );
        const staged = await stageConsumerWorkspace({
          files,
          root: await realpath(root),
          staging,
          packages: discovered,
        });
        expect(
          JSON.parse(
            await readFile(path.join(staging, "package.json"), "utf8"),
          ),
        ).toEqual(sourceRoot.manifest);
        const rootWorkspace: unknown = parse(
          await readFile(path.join(staging, "pnpm-workspace.yaml"), "utf8"),
        );
        expect(rootWorkspace).toMatchObject({
          catalog: defaultCatalog,
          catalogs: namedCatalog,
        });
        if (!consumerRecord(rootWorkspace))
          throw new Error("missing staged workspace");
        expect(Object.keys(rootWorkspace).sort()).toEqual([
          "catalog",
          "catalogs",
          "packages",
        ]);
        expect(
          parse(
            await readFile(
              path.join(staging, "packages/owner/pnpm-workspace.yaml"),
              "utf8",
            ),
          ),
        ).toEqual({ packages: ["children/*"], catalog: nestedCatalog });
        expect(
          (await readdir(path.join(staging, "packages/owner"))).sort(),
        ).toEqual(["children", "package.json", "pnpm-workspace.yaml"]);
        for (const [name, expected] of [
          ["library", { react: "18.3.1", typescript: "6.0.3" }],
          ["child", { react: "19.2.0" }],
        ] as const) {
          const member = staged.get(name);
          if (member === undefined) throw new Error("missing staged package");
          const packed = path.join(directory, name);
          await mkdir(packed);
          execFileSync(
            executable,
            [
              "--config.ignore-scripts=true",
              "--config.manage-package-manager-versions=false",
              "pack",
              "--pack-destination",
              packed,
            ],
            { cwd: member, stdio: "pipe" },
          );
          const archive = (await readdir(packed)).at(0);
          if (archive === undefined)
            throw new Error("pack did not produce archive");
          const manifest: unknown = JSON.parse(
            execFileSync(
              "tar",
              ["-xOf", path.join(packed, archive), "package/package.json"],
              { encoding: "utf8" },
            ),
          );
          expect(manifest).toMatchObject({ dependencies: expected });
          expect(
            execFileSync(
              "tar",
              ["-xOf", path.join(packed, archive), "package/vendor/runtime.js"],
              { encoding: "utf8" },
            ),
          ).toBe("export const vendored = true;\n");
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test("malformed catalog sources and conflicting Bun definitions fail before packing", async () => {
    const cases = [
      { source: "catalog: [react]", manifest: { private: true } },
      { source: "catalog: {react: 18}", manifest: { private: true } },
      { source: "catalogs: {compiler: []}", manifest: { private: true } },
      {
        source: "catalogs: {compiler: {typescript: ''}}",
        manifest: { private: true },
      },
      { source: "catalog: {}\ncatalog: {}", manifest: { private: true } },
      { source: "[invalid", manifest: { private: true } },
      {
        source: undefined,
        manifest: {
          private: true,
          catalog: { react: "18.3.1" },
          workspaces: { packages: [], catalog: { react: "19.2.0" } },
        },
      },
    ];
    for (const item of cases) {
      const root = await mkdtemp(
        path.join(tmpdir(), "consumer-invalid-catalog-"),
      );
      try {
        const staging = path.join(root, "stage");
        await mkdir(staging);
        const files: Record<string, string> =
          item.source === undefined
            ? {}
            : { "pnpm-workspace.yaml": item.source };
        await assert.rejects(() =>
          stageConsumerWorkspace({
            files,
            root,
            staging,
            packages: new Map([
              [
                "root",
                { directory: ".", name: "root", manifest: item.manifest },
              ],
            ]),
          }),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("installed tool-bin collisions fail before running fixture commands", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "consumer-bin-collision-"),
    );
    try {
      await mkdir(path.join(directory, "node_modules/.bin"), {
        recursive: true,
      });
      await assertConsumerInstalledToolBins(directory);
      for (const name of consumerReservedToolBins) {
        await writeFile(
          path.join(directory, `node_modules/.bin/${name}`),
          "#!/bin/sh\necho local-manager\n",
          { mode: 0o755 },
        );
        let lifecycleStarted = false;
        const lifecycle = async () => {
          await assertConsumerInstalledToolBins(directory);
          lifecycleStarted = true;
          return Bun.spawnSync(["/bin/sh", "-c", `${name} --version`], {
            cwd: directory,
            env: {
              ...process.env,
              PATH: path.join(directory, "node_modules/.bin"),
            },
          });
        };
        await assert.rejects(
          lifecycle(),
          new RegExp(`installed consumer binary ${name} conflicts`, "u"),
        );
        expect(lifecycleStarted).toBe(false);
        await rm(path.join(directory, `node_modules/.bin/${name}`));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("named private workspace owners remain discoverable but cannot be selected as consumers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "consumer-private-owner-"));
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Consumer selection must precede provisioning"),
    );
    try {
      await mkdir(path.join(root, "packages/owner"), { recursive: true });
      await mkdir(path.join(root, "fixtures/node"), { recursive: true });
      const files = {
        "package.json": JSON.stringify({
          name: "root",
          private: true,
          workspaces: ["packages/*"],
        }),
        "packages/owner/package.json": JSON.stringify({
          name: "owner",
          private: true,
          workspaces: ["children/*"],
        }),
      };
      for (const [file, content] of Object.entries(files))
        await writeFile(path.join(root, file), content);
      const discovered = discoverConsumerPackages(files);
      expect([...discovered.keys()].sort()).toEqual(["owner", "root"]);
      execFileSync("git", ["init", "-q"], { cwd: root });
      for (const pkg of discovered.values()) {
        await writeFile(
          path.join(root, "fixtures/consumer-compat.json"),
          JSON.stringify({
            packages: [
              {
                package: pkg.directory,
                fixture: "node",
                kind: "node",
                build: ["npm", "run", "build"],
                smoke: ["node", "smoke.mjs"],
              },
            ],
          }),
        );
        execFileSync("git", ["add", "."], { cwd: root });
        await assert.rejects(
          runConsumerCompat({
            root,
            packages: [pkg.directory],
            consumerNode: policy.consumerNode,
            fixturePath: "fixtures",
            policy,
          }),
          /selected package is not a public root or declared workspace package/u,
        );
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
  test("a React package cannot select a node fixture before provisioning or installing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "consumer-kind-"));
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Fixture validation must happen before network provisioning"),
    );
    try {
      await mkdir(path.join(root, "fixtures/node"), { recursive: true });
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "react-library",
          version: "1.0.0",
          peerDependencies: { react: ">=18" },
        }),
      );
      await writeFile(
        path.join(root, "fixtures/consumer-compat.json"),
        JSON.stringify({
          packages: [
            {
              package: ".",
              fixture: "node",
              kind: "node",
              build: ["npm", "run", "build"],
              smoke: ["node", "smoke.mjs"],
            },
          ],
        }),
      );
      await writeFile(
        path.join(root, "fixtures/node/package.json"),
        JSON.stringify({
          private: true,
          scripts: { build: "tsc" },
        }),
      );
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      await assert.rejects(
        runConsumerCompat({
          root,
          packages: ["."],
          consumerNode: policy.consumerNode,
          fixturePath: "fixtures",
          policy,
        }),
        /requires fixture kind react/u,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
  test("fixture kind follows published React peers rather than caller choice", () => {
    const fixture = {
      package: ".",
      fixture: "library",
      kind: "node",
      build: ["npm", "run", "build"],
      smoke: ["node", "smoke.mjs"],
    } satisfies ConsumerFixture;
    const pkg = { directory: ".", name: "library", manifest: {} };
    expect(() => assertConsumerFixtureKind({ fixture, pkg })).not.toThrow();
    const react = { ...pkg, manifest: { peerDependencies: { react: ">=18" } } };
    expect(() => assertConsumerFixtureKind({ fixture, pkg: react })).toThrow(
      "fixture kind react",
    );
    const reactFixture = {
      ...fixture,
      kind: "react",
    } satisfies ConsumerFixture;
    expect(() =>
      assertConsumerFixtureKind({ fixture: reactFixture, pkg: react }),
    ).not.toThrow();
    expect(() =>
      assertConsumerFixtureKind({ fixture: reactFixture, pkg }),
    ).toThrow("fixture kind node");
    for (const peer of [null, 18, "latest", ""]) {
      expect(() =>
        assertConsumerFixtureKind({
          fixture: reactFixture,
          pkg: { ...pkg, manifest: { peerDependencies: { react: peer } } },
        }),
      ).toThrow("invalid published React peer");
    }
  });
  test("pack staging preserves relative workspace references and public root identity", () => {
    const root = {
      directory: ".",
      name: "public-root",
      manifest: {
        name: "public-root",
        version: "1.0.0",
        main: "dist/index.js",
      },
    };
    const library = {
      directory: "packages/library",
      name: "@example/library",
      manifest: { dependencies: { "@example/core": "workspace:../core" } },
    };
    const core = {
      directory: "packages/core",
      name: "@example/core",
      manifest: { version: "1.0.0" },
    };
    const packages = new Map(
      [root, library, core].map((pkg) => [pkg.name, pkg]),
    );
    const paths = consumerStagingPaths(packages);
    expect(paths.get(root.name)).toBe(".");
    const libraryPath = paths.get(library.name);
    if (!libraryPath) throw new Error("missing staged library");
    const corePath = paths.get(core.name);
    if (!corePath) throw new Error("missing staged core");
    expect(path.posix.join(libraryPath, "../core")).toBe(corePath);
    expect(consumerPackRootManifest(packages, {})).toEqual(root.manifest);
    expect(
      consumerPackRootManifest(
        new Map([...packages].filter(([name]) => name !== root.name)),
        {},
      ),
    ).toEqual({ private: true });
  });
  test("fixture source directories are allowed but dependency-manager config is rejected", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "consumer-fixture-"));
    try {
      await mkdir(path.join(directory, "src"));
      await writeFile(
        path.join(directory, "package.json"),
        JSON.stringify({ private: true, scripts: { build: "tsc" } }),
      );
      await writeFile(path.join(directory, "src/use.ts"), "export {};\n");
      await assertConsumerFixtureFiles(directory);
      await writeFile(
        path.join(directory, ".npmrc"),
        "legacy-peer-deps=true\n",
      );
      await assert.rejects(
        assertConsumerFixtureFiles(directory),
        /dependency-manager configuration/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("both managers bind direct and transitive closure to identical artifacts and consumer pins", () => {
    const artifacts = new Map([
      ["@example/library", "/artifacts/library.tgz"],
      ["@example/core", "/artifacts/core.tgz"],
    ]);
    for (const manager of ["npm", "pnpm"] as const) {
      const bound = bindConsumerManifest({
        manifest: {
          dependencies: { "@example/core": "^1", react: "^19" },
          devDependencies: { typescript: "^7" },
        },
        artifacts,
        typescript: "6.0.3",
        react: { react: "18.0.0" },
        manager,
      });
      const overrides =
        bound.manager === "npm"
          ? bound.manifest["overrides"]
          : bound.workspace.overrides;
      const owned = {
        "@example/library": "file:/artifacts/library.tgz",
        "@example/core": "file:/artifacts/core.tgz",
        typescript: "6.0.3",
        react: "18.0.0",
      };
      expect(overrides).toEqual(owned);
      if (bound.manager === "pnpm")
        expect(bound.workspace.packages).toEqual(["."]);
      expect(bound.manifest["dependencies"]).toEqual({
        "@example/library": owned["@example/library"],
        "@example/core": owned["@example/core"],
        react: "18.0.0",
      });
      expect(bound.manifest["devDependencies"]).toEqual({
        typescript: "6.0.3",
      });
    }
    expect(() =>
      bindConsumerManifest({
        manifest: { pnpm: { overrides: { typescript: "7.0.2" } } },
        artifacts,
        typescript: "6.0.3",
        react: {},
        manager: "pnpm",
      }),
    ).toThrow("dependency-manager setting");
  });
  test("requires an explicit fixture and argument arrays for every package", () => {
    const entry = {
      package: "packages/library",
      fixture: "library",
      kind: "react",
      build: ["npm", "run", "build"],
      smoke: ["node", "smoke.mjs"],
    } satisfies ConsumerFixture;
    expect(parseConsumerFixtures({ packages: [entry] })).toEqual([entry]);
    for (const patch of [
      { fixture: "../source" },
      { kind: "auto" },
      { build: "npm run build" },
      { smoke: [] },
      { main: "src/index.ts" },
    ]) {
      expect(() =>
        parseConsumerFixtures({ packages: [{ ...entry, ...patch }] }),
      ).toThrow();
    }
    expect(() => parseConsumerFixtures({ packages: [entry, entry] })).toThrow(
      "duplicate",
    );
  });

  test("CLI fails on absent, unknown, duplicated and empty selection inputs", () => {
    const args = [
      "--packages",
      '["packages/library"]',
      "--consumer-node",
      "22.23.3",
      "--fixture-path",
      "fixtures/consumer",
    ];
    expect(parseConsumerCompatArguments(args)).toEqual({
      mode: "run",
      packages: ["packages/library"],
      consumerNode: "22.23.3",
      fixturePath: "fixtures/consumer",
    });
    expect(parseConsumerCompatArguments(["--help"])).toEqual({ mode: "help" });
    for (const bad of [
      [],
      args.slice(0, -1),
      [...args, "--unknown", "value"],
      [...args, "--packages", "[]"],
      ["--packages", "[]", ...args.slice(2)],
    ])
      expect(() => parseConsumerCompatArguments(bad)).toThrow();
  });

  test("discovers declared workspace closure rather than arbitrary fixture manifests", () => {
    const manifest = (value: Record<string, unknown>) => JSON.stringify(value);
    const files = {
      "package.json": manifest({
        name: "root",
        private: true,
        workspaces: ["packages/*", "!packages/omitted"],
      }),
      "packages/library/package.json": manifest({
        name: "@example/library",
        version: "1.0.0",
        dependencies: { "@example/core": "workspace:^" },
      }),
      "packages/core/package.json": manifest({
        name: "@example/core",
        version: "2.0.0",
      }),
      "packages/omitted/package.json": manifest({ name: "omitted" }),
      "fixtures/package.json": manifest({
        name: "@example/core",
        workspaces: ["nested/*"],
      }),
      "fixtures/nested/tool/package.json": manifest({ name: "fixture-tool" }),
      "fixtures/broken/package.json": "not a manifest",
      "fixtures/broken/pnpm-workspace.yaml": "[invalid yaml",
    };
    const packages = discoverConsumerPackages(files);
    expect([...packages.keys()].sort()).toEqual([
      "@example/core",
      "@example/library",
      "root",
    ]);
    const library = packages.get("@example/library");
    if (!library) throw new Error("missing library fixture");
    expect(
      [
        ...consumerPackageClosure({
          selected: library,
          packages,
          files,
        }).keys(),
      ].sort(),
    ).toEqual(["@example/core", "@example/library"]);
    expect(
      [
        ...discoverConsumerPackages({
          ...files,
          "pnpm-workspace.yaml": "packages:\n  - packages/core\n",
        }).keys(),
      ].sort(),
    ).toEqual(["@example/core", "root"]);
    expect(() =>
      discoverConsumerPackages({
        "pnpm-workspace.yaml": "packages:\n  - packages/core\n",
        "packages/core/package.json": files["packages/core/package.json"],
      }),
    ).toThrow("adjacent tracked package.json: pnpm-workspace.yaml");
  });

  test("public packed manifests require valid versions while private workspace owners may omit them", () => {
    for (const version of [
      undefined,
      null,
      1,
      "",
      "1",
      "1.0",
      "^1.0.0",
      "latest",
      "1.0.0.0",
    ])
      expect(() =>
        assertConsumerPublishableManifest({
          directory: "packages/library",
          manifest:
            version === undefined
              ? { name: "library" }
              : { name: "library", version },
        }),
      ).toThrow("semver-valid version");
    for (const version of ["1.0.0", "0.0.0", "1.0.0-rc.1", "1.0.0+build.1"])
      expect(() =>
        assertConsumerPublishableManifest({
          directory: "packages/library",
          manifest: { name: "library", version },
        }),
      ).not.toThrow();
    expect(() =>
      assertConsumerPublishableManifest({
        directory: ".",
        manifest: { private: true },
      }),
    ).not.toThrow();
    const selected = {
      directory: "packages/library",
      name: "library",
      manifest: {
        name: "library",
        version: "1.0.0",
        dependencies: { core: "workspace:*" },
      },
    };
    const core = { directory: "packages/core", name: "core", manifest: {} };
    expect(() =>
      consumerPackageClosure({
        selected,
        packages: new Map([
          [selected.name, selected],
          [core.name, core],
        ]),
        files: {},
      }),
    ).toThrow("semver-valid version: packages/core");
  });

  test("both bundled-dependency fields fail closed for selected and transitive package artifacts", () => {
    for (const field of consumerBundledDependencyFields)
      for (const value of [[], ["dependency"], true, false, null]) {
        const selected = {
          directory: "packages/library",
          name: "library",
          manifest: { name: "library", version: "1.0.0", [field]: value },
        };
        expect(() =>
          consumerPackageClosure({
            selected,
            packages: new Map([[selected.name, selected]]),
            files: {},
          }),
        ).toThrow(`does not support ${field}: packages/library`);
        const core = {
          directory: "packages/core",
          name: "core",
          manifest: { name: "core", version: "1.0.0", [field]: value },
        };
        const parent = {
          directory: "packages/parent",
          name: "parent",
          manifest: {
            name: "parent",
            version: "1.0.0",
            dependencies: { core: "workspace:*" },
          },
        };
        const files = {
          "package.json": JSON.stringify({
            private: true,
            workspaces: ["packages/*"],
          }),
          "packages/parent/package.json": JSON.stringify(parent.manifest),
          "packages/core/package.json": JSON.stringify(core.manifest),
        };
        expect(() =>
          consumerPackageClosure({
            selected: parent,
            packages: discoverConsumerPackages(files),
            files,
          }),
        ).toThrow(`does not support ${field}: packages/core`);
      }
  });

  test("catalog dependencies selecting local packages require explicit workspace intent in every published section", () => {
    for (const source of ["pnpm", "bun"] as const)
      for (const owner of [".", "packages/owner"])
        for (const catalog of ["", "tooling"])
          for (const field of consumerPublishedDependencyFields) {
            const directory =
              owner === "."
                ? "packages/library"
                : "packages/owner/children/library";
            const state =
              catalog === ""
                ? { catalog: { "@example/core": "^1", external: "^3" } }
                : {
                    catalogs: {
                      tooling: { "@example/core": "^1", external: "^3" },
                    },
                  };
            const rootState =
              owner === "."
                ? state
                : {
                    catalog: { "@example/core": "^2" },
                    catalogs: { tooling: { "@example/core": "^2" } },
                  };
            const files: Record<string, string> = {
              "package.json": JSON.stringify({
                private: true,
                workspaces:
                  source === "bun"
                    ? { packages: ["packages/**"], ...rootState }
                    : ["packages/**"],
              }),
              "packages/core/package.json": JSON.stringify({
                name: "@example/core",
                version: "1.2.0",
              }),
              [`${directory}/package.json`]: JSON.stringify({
                name: "library",
                version: "1.0.0",
                [field]: { "@example/core": `catalog:${catalog}` },
              }),
            };
            if (source === "pnpm")
              files["pnpm-workspace.yaml"] = stringify({
                packages: ["packages/**"],
                ...rootState,
              });
            if (owner !== ".") {
              files[`${owner}/package.json`] = JSON.stringify({
                private: true,
                workspaces:
                  source === "bun"
                    ? { packages: ["children/*"], ...state }
                    : ["children/*"],
              });
              if (source === "pnpm")
                files[`${owner}/pnpm-workspace.yaml`] = stringify({
                  packages: ["children/*"],
                  ...state,
                });
            }
            const closure = () => {
              const packages = discoverConsumerPackages(files);
              const selected = packages.get("library");
              if (selected === undefined)
                throw new Error("missing selected fixture");
              return consumerPackageClosure({ selected, packages, files });
            };
            expect(closure).toThrow(
              "catalog dependency @example/core resolves to workspace package @example/core; use workspace:",
            );
            files["packages/core/package.json"] = JSON.stringify({
              name: "@example/core",
              version: "2.0.0",
            });
            expect([...closure().keys()]).toEqual(["library"]);
            files[`${directory}/package.json`] = JSON.stringify({
              name: "library",
              version: "1.0.0",
              [field]: { external: `catalog:${catalog}` },
            });
            expect([...closure().keys()]).toEqual(["library"]);
          }
  });

  test("unresolved workspace dependencies fail instead of falling through to registry", () => {
    const pkg = {
      name: "library",
      directory: ".",
      manifest: {
        name: "library",
        version: "1.0.0",
        dependencies: { missing: "workspace:*" },
      },
    };
    expect(() =>
      consumerPackageClosure({
        selected: pkg,
        packages: new Map([[pkg.name, pkg]]),
        files: {},
      }),
    ).toThrow("unresolved workspace dependency");
  });

  test("workspace aliases fail with a package-name migration instruction", () => {
    const core = {
      name: "@example/core",
      directory: "packages/core",
      manifest: { name: "@example/core", version: "1.0.0" },
    };
    const pkg = {
      name: "library",
      directory: ".",
      manifest: {
        name: "library",
        version: "1.0.0",
        dependencies: { alias: "workspace:@example/core@*" },
      },
    };
    expect(() =>
      consumerPackageClosure({
        selected: pkg,
        packages: new Map([[core.name, core]]),
        files: {},
      }),
    ).toThrow(
      "workspace alias specifiers are not supported by consumer-compat: alias -> workspace:@example/core@*; use the package name as the dependency key",
    );
  });

  test("selects the oldest actual published version across the entire peer range", () => {
    const versions = ["19.0.0", "18.0.0", "17.0.2", "18.0.0-rc.0", "17.0.1"];
    expect(oldestPublishedConsumerVersion(versions, ">=17.0.0 <20")).toBe(
      "17.0.1",
    );
    expect(oldestPublishedConsumerVersion(versions, "^18 || ^19")).toBe(
      "18.0.0",
    );
    expect(() => oldestPublishedConsumerVersion(versions, "^20")).toThrow(
      "no published",
    );
  });
});

describe("isolated consumer runtime", () => {
  test("a dev-only executable on the inherited PATH is unavailable to consumers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "consumer-dev-path-"));
    try {
      const devBin = path.join(directory, "dev-bin");
      const pinnedBin = path.join(directory, "pinned-bin");
      await mkdir(devBin);
      await mkdir(pinnedBin);
      await writeFile(
        path.join(devBin, "consumer-dev-only"),
        "#!/bin/sh\nprintf dev-only\n",
        { mode: 0o755 },
      );
      const inherited = { ...process.env, PATH: devBin };
      const control = Bun.spawnSync(["/bin/sh", "-c", "consumer-dev-only"], {
        env: inherited,
      });
      expect(control.exitCode).toBe(0);
      expect(control.stdout.toString()).toBe("dev-only");
      const env = consumerCommandEnvironment({
        tools: { bin: pinnedBin },
        directory,
        home: directory,
        environment: inherited,
      });
      const result = Bun.spawnSync(["/bin/sh", "-c", "consumer-dev-only"], {
        env,
      });
      expect(result.exitCode).toBe(127);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain("consumer-dev-only");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("nested manager invocations execute pinned wrappers before bundled and inherited producers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "consumer-wrappers-"));
    try {
      const nodeBin = path.join(directory, "node-bin");
      const managerBin = path.join(directory, "pinned-managers");
      const fixture = path.join(directory, "fixture");
      await Promise.all([mkdir(nodeBin), mkdir(managerBin), mkdir(fixture)]);
      const node = path.join(nodeBin, "node");
      await writeFile(node, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
      for (const manager of ["npm", "npx", "pnpm"] as const) {
        const version =
          manager === "pnpm" ? policy.consumerPnpm : policy.consumerNpm;
        await writeFile(
          path.join(managerBin, manager === "npx" ? "npx-cli.js" : manager),
          `#!/bin/sh\n[ "$1" = --version ] || exit 1\nprintf '%s\\n' '${version}'\n`,
          { mode: 0o755 },
        );
        await writeFile(
          path.join(nodeBin, manager),
          "#!/bin/sh\necho bundled-manager\n",
          { mode: 0o755 },
        );
      }
      const tools = await writeConsumerToolWrappers({
        node,
        npm: path.join(managerBin, "npm"),
        pnpm: path.join(managerBin, "pnpm"),
        directory: path.join(directory, "consumer-bin"),
      });
      const script = path.join(fixture, "nested.sh");
      await writeFile(
        script,
        "#!/bin/sh\nset -eu\nnpm --version\nnpx --version\npnpm --version\n",
      );
      const env = consumerCommandEnvironment({
        tools,
        directory: fixture,
        home: directory,
      });
      const result = Bun.spawnSync(["/bin/sh", script], { cwd: fixture, env });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(
        `${policy.consumerNpm}\n${policy.consumerNpm}\n${policy.consumerPnpm}\n`,
      );
      const oldOrder = `${nodeBin}${path.delimiter}${tools.bin}`;
      const regression = Bun.spawnSync(["/bin/sh", script], {
        cwd: fixture,
        env: { ...env, PATH: oldOrder },
      });
      expect(regression.stdout.toString()).toBe(
        "bundled-manager\nbundled-manager\nbundled-manager\n",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("both managers install, typecheck, build and smoke using the consumer Node executable", () => {
    const tools = {
      node: "/consumer/node",
      npm: "/consumer/npm-cli.js",
      pnpm: "/consumer/pnpm",
      bin: "/consumer/bin",
    };
    const fixture = {
      package: ".",
      fixture: "node",
      kind: "node",
      build: ["npm", "run", "build"],
      smoke: ["node", "smoke.mjs"],
    } satisfies ConsumerFixture;
    for (const manager of ["npm", "pnpm"] as const) {
      const commands = consumerFixtureCommands({
        manager,
        tools,
        directory: "/fixture",
        home: "/home",
        fixture: {
          ...fixture,
          build: [...fixture.build],
          smoke: [...fixture.smoke],
        },
      });
      expect(commands).toHaveLength(5);
      expect(commands.every((argv) => argv[0] === tools.node)).toBe(true);
      expect(commands[0]).toEqual(
        manager === "pnpm"
          ? [
              tools.node,
              tools.pnpm,
              "pm",
              "install",
              "--ignore-scripts",
              "--no-frozen-lockfile",
              "--store-dir",
              "/home/pnpm-store",
            ]
          : [
              tools.node,
              tools.npm,
              "install",
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
            ],
      );
      expect(commands[0]).toContain("--ignore-scripts");
      expect(commands[1]).toEqual(
        manager === "pnpm"
          ? [tools.node, tools.pnpm, "pm", "rebuild", "--pending"]
          : [tools.node, tools.npm, "rebuild"],
      );
      expect(commands[2]).toEqual([
        tools.node,
        "/fixture/node_modules/typescript/bin/tsc",
        "--noEmit",
      ]);
      expect(commands[3]).toEqual([tools.node, tools.npm, "run", "build"]);
      expect(commands[4]).toEqual([tools.node, "smoke.mjs"]);
    }
    expect(() =>
      consumerFixtureCommands({
        manager: "npm",
        tools,
        directory: "/fixture",
        home: "/home",
        fixture: {
          ...fixture,
          build: ["npm", "install"],
          smoke: [...fixture.smoke],
        },
      }),
    ).toThrow("declared");
  });
  test("checks exact official archive filename and digest before extraction", () => {
    const archive = Buffer.from("official archive fixture");
    const filename = "node-v22.23.3-linux-x64.tar.xz";
    const checksums = `${createHash("sha256").update(archive).digest("hex")}  ${filename}\n`;
    expect(() =>
      verifyConsumerNodeArchive({ filename, archive, checksums }),
    ).not.toThrow();
    expect(() =>
      verifyConsumerNodeArchive({
        filename,
        archive: Buffer.from("different bytes"),
        checksums,
      }),
    ).toThrow("checksum mismatch");
    expect(() =>
      verifyConsumerNodeArchive({
        filename,
        archive,
        checksums: checksums + checksums,
      }),
    ).toThrow("checksum mismatch");
    expect(() =>
      verifyConsumerNodeArchive({
        filename: "node-v22.23.3-linux-arm64.tar.xz",
        archive,
        checksums,
      }),
    ).toThrow("checksum mismatch");
  });

  test("consumer environment excludes inherited runtime and module lookup paths", () => {
    const env = consumerCommandEnvironment({
      tools: { bin: "/isolated/managers/bin" },
      directory: "/isolated/fixture",
      home: "/isolated/home",
      environment: {
        PATH: "/dev/bin",
        NODE_PATH: "/repository/modules",
        NODE_OPTIONS: "--no-warnings",
        npm_config_offline: "true",
        NPM_CONFIG_PREFIX: "/shared/prefix",
        PNPM_HOME: "/shared/pnpm",
        YARN_CACHE_FOLDER: "/shared/yarn",
        XDG_CONFIG_HOME: "/shared/config",
        KEEP: "value",
      },
    });
    expect(env["PATH"]?.split(path.delimiter)).toEqual([
      "/isolated/managers/bin",
      "/isolated/fixture/node_modules/.bin",
      "/usr/bin",
      "/bin",
    ]);
    expect(env["NODE_PATH"]).toBeUndefined();
    expect(env["NODE_OPTIONS"]).toBeUndefined();
    expect(env["HOME"]).toBe("/isolated/home");
    expect(env["npm_config_userconfig"]).toBe("/isolated/home/npmrc");
    expect(env["npm_config_registry"]).toBe("https://registry.npmjs.org/");
    expect(env["npm_config_offline"]).toBeUndefined();
    expect(env["NPM_CONFIG_PREFIX"]).toBeUndefined();
    expect(env["PNPM_HOME"]).toBeUndefined();
    expect(env["YARN_CACHE_FOLDER"]).toBeUndefined();
    expect(env["XDG_CONFIG_HOME"]).toBe("/isolated/home/config");
    expect(env["KEEP"]).toBe("value");
  });
});
