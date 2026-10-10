/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

test("engine integration refuses non-CI execution before preparing services", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      path.join(import.meta.dirname, "cloud-setup-integration.ts"),
    ],
    { env: { ...process.env, CI: "false" } },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain(
    "This integration runs only in Linux CI",
  );
});

test("every owned-state shell fragment remains syntactically valid Bash", () => {
  const source = readFileSync(
    path.join(import.meta.dirname, "cloud-setup-integration.ts"),
    "utf8",
  );
  const programs = [
    ...source.matchAll(/const \w+ = String\.raw`([\s\S]*?)`;/g),
  ];
  expect(programs.length).toBeGreaterThan(0);
  for (const program of programs) {
    const body = program.at(1);
    if (body === undefined)
      throw new Error("Owned-state shell fragment is absent");
    const result = Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(body) });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  }
});

test("nonroot dependency and Vite ownership verifier parses without executing writes", () => {
  const source = readFileSync(
    path.join(import.meta.dirname, "cloud-setup-integration.ts"),
    "utf8",
  );
  const verifier = source.match(/const verifyWrite = `([\s\S]*?)`;/)?.at(1);
  expect(verifier).toBeDefined();
  if (verifier === undefined)
    throw new Error("Nonroot ownership verifier is absent");
  const result = Bun.spawnSync(["node", "--check"], {
    stdin: Buffer.from(verifier),
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
});
