import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import policy from "../toolchain.json";
import {
  consumerCommandEnvironment,
  assertConsumerFixtureFiles,
  consumerFixtureCommands,
  verifyConsumerNodeArchive,
  writeConsumerToolWrappers,
} from "./consumer-compat";
import { parseConsumerCompatArguments } from "./consumer-compat-arguments";
import {
  consumerPackageClosure,
  consumerStagingPaths,
  consumerPackRootManifest,
  bindConsumerManifest,
  discoverConsumerPackages,
  oldestPublishedConsumerVersion,
  parseConsumerFixtures,
  type ConsumerFixture,
} from "./consumer-compat-config";

describe("consumer compatibility declarations", () => {
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
    expect(path.posix.join(libraryPath, "../core")).toBe(paths.get(core.name));
    expect(consumerPackRootManifest(packages)).toEqual(root.manifest);
    expect(
      consumerPackRootManifest(
        new Map([
          [library.name, library],
          [core.name, core],
        ]),
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
      await expect(
        assertConsumerFixtureFiles(directory),
      ).resolves.toBeUndefined();
      await writeFile(
        path.join(directory, ".npmrc"),
        "legacy-peer-deps=true\n",
      );
      await expect(assertConsumerFixtureFiles(directory)).rejects.toThrow(
        "dependency-manager configuration",
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
    };
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
      [...consumerPackageClosure(library, packages).keys()].sort(),
    ).toEqual(["@example/core", "@example/library"]);
    expect(
      [
        ...discoverConsumerPackages({
          ...files,
          "pnpm-workspace.yaml": "packages:\n  - packages/core\n",
        }).keys(),
      ].sort(),
    ).toEqual(["@example/core", "root"]);
    expect([
      ...discoverConsumerPackages({
        "pnpm-workspace.yaml": "packages:\n  - packages/core\n",
        "packages/core/package.json": files["packages/core/package.json"],
      }).keys(),
    ]).toEqual(["@example/core"]);
  });

  test("unresolved workspace dependencies fail instead of falling through to registry", () => {
    const pkg = {
      name: "library",
      directory: ".",
      manifest: { dependencies: { missing: "workspace:*" } },
    };
    expect(() =>
      consumerPackageClosure(pkg, new Map([[pkg.name, pkg]])),
    ).toThrow("unresolved workspace dependency");
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
  test("nested manager invocations execute pinned wrappers before bundled and inherited producers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "consumer-wrappers-"));
    try {
      const nodeBin = path.join(directory, "node-bin");
      const managerBin = path.join(directory, "pinned-managers");
      const fixture = path.join(directory, "fixture");
      await Promise.all([mkdir(nodeBin), mkdir(managerBin), mkdir(fixture)]);
      const node = path.join(nodeBin, "node");
      await writeFile(node, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
      for (const manager of ["npm", "pnpm"] as const) {
        const version =
          manager === "npm" ? policy.consumerNpm : policy.consumerPnpm;
        await writeFile(
          path.join(managerBin, manager),
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
        "#!/bin/sh\nset -eu\nnpm --version\npnpm --version\n",
      );
      const env = consumerCommandEnvironment({
        tools,
        directory: fixture,
        home: directory,
      });
      const result = Bun.spawnSync(["/bin/sh", script], { cwd: fixture, env });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(
        `${policy.consumerNpm}\n${policy.consumerPnpm}\n`,
      );
      const oldOrder = `${nodeBin}${path.delimiter}${tools.bin}`;
      const regression = Bun.spawnSync(["/bin/sh", script], {
        cwd: fixture,
        env: { ...env, PATH: oldOrder },
      });
      expect(regression.stdout.toString()).toBe(
        "bundled-manager\nbundled-manager\n",
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
      expect(commands).toHaveLength(4);
      expect(commands.every((argv) => argv[0] === tools.node)).toBe(true);
      expect(commands[0]?.slice(0, 3)).toEqual([
        tools.node,
        tools[manager],
        "install",
      ]);
      expect(commands[1]).toEqual([
        tools.node,
        "/fixture/node_modules/typescript/bin/tsc",
        "--noEmit",
      ]);
      expect(commands[2]).toEqual([tools.node, tools.npm, "run", "build"]);
      expect(commands[3]).toEqual([tools.node, "smoke.mjs"]);
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

  test("consumer runtime precedes local tools and inherited dev runtime; module lookup cannot inherit repository paths", () => {
    const env = consumerCommandEnvironment({
      tools: { bin: "/isolated/managers/bin:/isolated/node/bin" },
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
    expect(env["PATH"]?.split(":").slice(0, 3)).toEqual([
      "/isolated/managers/bin",
      "/isolated/node/bin",
      "/isolated/fixture/node_modules/.bin",
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
