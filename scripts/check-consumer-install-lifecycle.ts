import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  installConsumerFixtureDependencies,
  assertConsumerInstalledToolBins,
  provisionConsumerTools,
} from "../packages/oxlint-config/src/consumer-compat";
import { parseToolchainPolicy } from "../packages/oxlint-config/src/toolchain-schema";
import policyData from "../packages/oxlint-config/toolchain.json";
import { assertConsumerReleasePackParity } from "./check-consumer-release-pack";

const scratch = await mkdtemp(path.join(tmpdir(), "consumer-lifecycle-"));
try {
  const tools = await provisionConsumerTools(
    scratch,
    parseToolchainPolicy(policyData),
  );
  for (const manager of ["npm", "pnpm"] as const) {
    const directory = path.join(scratch, manager);
    const dependency = path.join(directory, "dependency");
    const home = path.join(directory, "home");
    await mkdir(dependency, { recursive: true });
    await mkdir(home);
    await writeFile(path.join(home, "npmrc"), "");
    await writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({
        name: "consumer-runtime-collision",
        version: "1.0.0",
        bin: { node: "node.cjs" },
        scripts: { install: "node install.cjs" },
      }),
    );
    await writeFile(
      path.join(dependency, "node.cjs"),
      '#!/usr/bin/env node\nrequire("node:fs").writeFileSync("runtime-collision-ran", "yes");\n',
      { mode: 0o755 },
    );
    await writeFile(
      path.join(dependency, "install.cjs"),
      'require("node:fs").writeFileSync("dependency-install-ran", "yes");\n',
    );
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "consumer-lifecycle-fixture",
        version: "1.0.0",
        private: true,
        dependencies: { "consumer-runtime-collision": "file:./dependency" },
        scripts: { install: "node install.cjs" },
      }),
    );
    await writeFile(
      path.join(directory, "install.cjs"),
      'require("node:fs").writeFileSync("fixture-install-ran", "yes");\n',
    );
    await assert.rejects(
      installConsumerFixtureDependencies({
        manager,
        tools,
        directory,
        home,
        fixture: {
          package: ".",
          fixture: ".",
          kind: "node",
          build: ["node", "build.cjs"],
          smoke: ["node", "smoke.cjs"],
        },
      }),
      /installed consumer binary node conflicts/,
    );
    for (const location of [
      directory,
      dependency,
      path.join(directory, "node_modules/consumer-runtime-collision"),
    ])
      for (const marker of [
        "runtime-collision-ran",
        "dependency-install-ran",
        "fixture-install-ran",
      ])
        await assert.rejects(access(path.join(location, marker)), {
          code: "ENOENT",
        });
    process.stdout.write(
      `${manager}: dependency runtime collision rejected before lifecycle execution\n`,
    );
    const nested = path.join(scratch, `${manager}-nested-bin`);
    const nestedBin = path.join(
      nested,
      manager === "npm"
        ? "node_modules/outer/node_modules/.bin"
        : "node_modules/.pnpm/inner@1.0.0/node_modules/.bin",
    );
    await mkdir(nestedBin, { recursive: true });
    await writeFile(
      path.join(nestedBin, "node"),
      "#!/bin/sh\nprintf yes > nested-runtime-ran\n",
      { mode: 0o755 },
    );
    await assert.rejects(async () => {
      await assertConsumerInstalledToolBins(nested);
      const result = spawnSync("node", ["--version"], {
        cwd: nested,
        env: {
          ...process.env,
          PATH: `${nestedBin}${path.delimiter}${tools.bin}`,
        },
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0);
    }, /installed consumer binary node conflicts/);
    await assert.rejects(access(path.join(nested, "nested-runtime-ran")), {
      code: "ENOENT",
    });
    process.stdout.write(
      `${manager}: nested lifecycle runtime collision rejected\n`,
    );
    const success = path.join(scratch, `${manager}-success`);
    const native = path.join(success, "dependency");
    const successHome = path.join(success, "home");
    await mkdir(native, { recursive: true });
    await mkdir(successHome);
    await writeFile(path.join(successHome, "npmrc"), "");
    await writeFile(
      path.join(native, "package.json"),
      JSON.stringify({
        name: "consumer-native-like",
        version: "1.0.0",
        scripts: { install: "node install.cjs" },
      }),
    );
    await writeFile(
      path.join(native, "install.cjs"),
      'require("node:fs").writeFileSync("native-ready", "yes");\n',
    );
    await writeFile(
      path.join(success, "package.json"),
      JSON.stringify({
        name: "consumer-lifecycle-success",
        version: "1.0.0",
        private: true,
        dependencies: { "consumer-native-like": "file:./dependency" },
        scripts: { rebuild: "node shadow.cjs" },
      }),
    );
    await writeFile(
      path.join(success, "shadow.cjs"),
      'require("node:fs").writeFileSync("shadow-rebuild-ran", "yes");\n',
    );
    if (manager === "pnpm")
      await writeFile(
        path.join(success, "pnpm-workspace.yaml"),
        "packages:\n  - .\n",
      );
    await installConsumerFixtureDependencies({
      manager,
      tools,
      directory: success,
      home: successHome,
      fixture: {
        package: ".",
        fixture: ".",
        kind: "node",
        build: ["node", "build.cjs"],
        smoke: ["node", "smoke.cjs"],
      },
    });
    assert.equal(
      await readFile(
        path.join(success, "node_modules/consumer-native-like/native-ready"),
        "utf8",
      ),
      "yes",
    );
    await assert.rejects(access(path.join(success, "shadow-rebuild-ran")), {
      code: "ENOENT",
    });
    process.stdout.write(
      `${manager}: approved dependency install ran through the built-in rebuild\n`,
    );
  }
  await assertConsumerReleasePackParity({ tools, scratch });
} finally {
  await rm(scratch, { recursive: true, force: true });
}
