/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  fixtureParity,
  fixtureRunPassed,
  fixtures,
  resolveCompiler,
} from "./typecheck-parity";

// These checks launch real compilers; the repository CI owns that workload.
test.skipIf(process.env.CI !== "true")(
  "real consumer configurations determine seeded activation and reject zero coverage",
  async () => {
    const repo = process.cwd();
    const policy: unknown = JSON.parse(
      await readFile(
        resolve(repo, "packages/oxlint-config/toolchain.json"),
        "utf8",
      ),
    );
    const compiler = await resolveCompiler(repo, policy);
    const fixture = fixtures.find(({ name }) => name === "unchecked-index");
    if (fixture === undefined)
      throw new Error("Missing unchecked-index fixture");
    const project = await mkdtemp(join(tmpdir(), "parity-real-config-"));
    try {
      for (const [name, source] of Object.entries(fixture.files)) {
        await writeFile(join(project, name), source);
      }
      const cases = [
        { strictNullChecks: false, noCheck: false, active: false },
        { strictNullChecks: true, noCheck: false, active: true },
        { strictNullChecks: true, noCheck: true, active: false },
      ];
      for (const configuration of cases) {
        await writeFile(
          join(project, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              noEmit: true,
              types: [],
              target: "ESNext",
              module: "ESNext",
              moduleResolution: "Bundler",
              noUncheckedIndexedAccess: true,
              strictNullChecks: configuration.strictNullChecks,
              noCheck: configuration.noCheck,
            },
            include: ["input.ts"],
          }),
        );
        const tsc = spawnSync(
          process.execPath,
          [compiler, "--noEmit", "--pretty", "false", "-p", project],
          { cwd: repo, encoding: "utf8", timeout: 10_000 },
        );
        const bun = spawnSync(
          process.execPath,
          ["check", "--no-pretty", "--all", "--threads=1", "-p", project],
          { cwd: repo, encoding: "utf8", timeout: 10_000 },
        );
        if (tsc.error) throw tsc.error;
        if (bun.error) throw bun.error;
        const result = fixtureParity({
          expected: fixture.codes,
          match: "all",
          baseline: { status: tsc.status, output: tsc.stdout + tsc.stderr },
          candidate: { status: bun.status, output: bun.stdout + bun.stderr },
        });
        expect(result.active).toBe(configuration.active);
        expect(result.passed).toBe(true);
        expect(result.tscCodes).toEqual(configuration.active ? [2322] : []);
        expect(result.bunCodes).toEqual(result.tscCodes);
        expect(fixtureRunPassed([result])).toBe(configuration.active);
        if (result.active) {
          expect(
            fixtureParity({
              expected: fixture.codes,
              match: "all",
              baseline: { status: tsc.status, output: tsc.stdout + tsc.stderr },
              candidate: { status: 0, output: "" },
            }).passed,
          ).toBe(false);
        }
      }
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  },
  70_000,
);
