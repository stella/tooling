import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(
  process.versions.node,
  "20.19.0",
  "Run the built CLI regression on the exact published Node floor",
);
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(
  root,
  "packages/oxlint-config/dist/publish-contract-cli.mjs",
);
const fixture = mkdtempSync(path.join(tmpdir(), "publish-target-node-floor-"));
try {
  writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({
      name: "publish-target-node-floor-fixture",
      version: "1.0.0",
      type: "module",
      engines: { node: "^20.19.0 || >=22.12.0" },
      exports: "./dist/index.js",
      scripts: { build: "tsdown" },
    }),
  );
  writeFileSync(
    path.join(fixture, "tsdown.config.ts"),
    'import { defineConfig } from "tsdown";\nimport { target } from "./build-target.ts";\nexport default defineConfig({ entry: ["index.ts"], target });\n',
  );
  writeFileSync(
    path.join(fixture, "build-target.ts"),
    'export const target: string = "es2022";\n',
  );
  writeFileSync(
    path.join(fixture, "index.ts"),
    'export const value: string = "consumer";\n',
  );
  // The fixture exercises the installed tsdown loader without another dependency install.
  symlinkSync(
    path.join(root, "node_modules"),
    path.join(fixture, "node_modules"),
    "dir",
  );
  execFileSync("git", ["init", "-q"], { cwd: fixture });
  execFileSync(
    "git",
    ["add", "package.json", "tsdown.config.ts", "build-target.ts", "index.ts"],
    { cwd: fixture },
  );
  for (const args of [["--write"], []]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: fixture,
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `Built publish-contract CLI failed on Node ${process.versions.node}: ${result.stderr !== "" ? result.stderr : result.stdout}`,
    );
  }
  const contract = JSON.parse(
    readFileSync(path.join(fixture, "publish-contract.json"), "utf8"),
  );
  assert.deepEqual(contract.target, {
    type: "javascript",
    targets: ["es2022"],
  });
  console.log(
    "Built publish-contract CLI resolved TypeScript config and relative import on Node 20.19.0",
  );
  const manifest = JSON.parse(
    readFileSync(path.join(fixture, "package.json"), "utf8"),
  );
  manifest.workspaces = ["vendor/*"];
  writeFileSync(path.join(fixture, "package.json"), JSON.stringify(manifest));
  mkdirSync(path.join(fixture, "vendor/library"), { recursive: true });
  writeFileSync(
    path.join(fixture, "vendor/library/package.json"),
    JSON.stringify({
      name: "vendor-contract-fixture",
      version: "1.0.0",
      types: "index.d.ts",
    }),
  );
  writeFileSync(
    path.join(fixture, "vendor/library/index.d.ts"),
    "export {};\n",
  );
  execFileSync("git", ["add", "package.json", "vendor"], { cwd: fixture });
  const vendor = spawnSync(process.execPath, [cli], {
    cwd: fixture,
    encoding: "utf8",
  });
  assert.equal(vendor.status, 1);
  assert.match(
    vendor.stderr,
    /Published workspace packages under vendor directories are not supported by publish-contract: vendor\/library\/package.json/,
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
