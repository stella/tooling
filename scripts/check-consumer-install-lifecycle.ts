import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  installConsumerFixtureDependencies,
  provisionConsumerTools,
} from "../packages/oxlint-config/src/consumer-compat";
import { parseToolchainPolicy } from "../packages/oxlint-config/src/toolchain-schema";
import policyData from "../packages/oxlint-config/toolchain.json";

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
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
