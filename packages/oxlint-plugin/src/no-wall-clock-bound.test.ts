import { expect, test } from "bun:test";
import path from "node:path";

test("reports wall-clock bounds only in test files", () => {
  const root = path.resolve(import.meta.dir, "../../..");
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--bun",
      path.join(root, "node_modules/.bin/oxlint"),
      "-c",
      "oxlint.config.ts",
      "--report-unused-disable-directives-severity=error",
      "--deny-warnings",
      "packages/oxlint-plugin/fixtures/__tests__/no-wall-clock-bound.fixture.ts",
      "packages/oxlint-plugin/fixtures/no-wall-clock-bound-nontest.fixture.ts",
    ],
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });

  expect(result.exitCode).toBe(0);
});
