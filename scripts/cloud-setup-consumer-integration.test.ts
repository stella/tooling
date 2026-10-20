/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import path from "node:path";

test("consumer integration refuses non-CI execution before reading or changing a snapshot", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      path.join(import.meta.dirname, "cloud-setup-consumer-integration.ts"),
      "/absent-consumer-snapshot",
    ],
    { env: { ...process.env, CI: "false" } },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain(
    "This consumer integration runs only in Linux CI",
  );
}, 15_000);
