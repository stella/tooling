import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import workspace from "../../../package.json";
import { scriptLifecycleStages } from "./toolchain-script-lifecycle";

test("pnpm lifecycle discovery agrees with the installed implementation", () => {
  const root = mkdtempSync(join(tmpdir(), "pnpm-lifecycle-"));
  const executable = fileURLToPath(
    new URL("../../../node_modules/pnpm/bin/pnpm.mjs", import.meta.url),
  );
  try {
    for (const enabled of [undefined, true, false]) {
      for (const suppressPre of [false, true]) {
        const scripts = {
          precore: `node -e 'console.log("stage:precore")'`,
          core: `${suppressPre ? "echo precore && " : ""}node -e 'console.log("stage:core")'`,
          postcore: `node -e 'console.log("stage:postcore")'`,
        };
        const manifest = {
          name: "lifecycle-fixture",
          private: true,
          packageManager: `pnpm@${workspace.devDependencies.pnpm}`,
          scripts,
        };
        const source =
          enabled === undefined
            ? "packages: []\n"
            : `enablePrePostScripts: ${enabled}\n`;
        writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
        writeFileSync(join(root, "pnpm-workspace.yaml"), source);
        const result = spawnSync(
          "node",
          [executable, "--dir", root, "--silent", "run", "core"],
          { encoding: "utf8", timeout: 15_000 },
        );
        expect(result.status, result.stderr).toBe(0);
        const actual = result.stdout
          .split(/\r?\n/)
          .filter((line) => line.startsWith("stage:"))
          .map((line) => line.slice("stage:".length));
        expect(
          scriptLifecycleStages({
            name: "core",
            manager: "pnpm",
            manifest,
            scripts,
            context: { pnpmWorkspace: { type: "tracked", source } },
          }),
        ).toEqual(actual);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
