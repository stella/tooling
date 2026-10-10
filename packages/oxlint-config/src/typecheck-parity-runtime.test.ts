/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  bunCheckArgs,
  compareDiagnosticSets,
  diagnosticCodes,
  diagnosticSet,
  fixtureParity,
  fixtureRunPassed,
  fixtures,
  resolveCompiler,
} from "./typecheck-parity";

// These checks launch real compilers; the repository CI owns that workload.
test.skipIf(process.env["CI"] !== "true")(
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
        const bun = spawnSync(process.execPath, bunCheckArgs(project), {
          cwd: repo,
          encoding: "utf8",
          timeout: 10_000,
        });
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

test.skipIf(process.env["CI"] !== "true")(
  "builtin checking bypasses a consumer check script",
  async () => {
    const project = await mkdtemp(join(tmpdir(), "parity-script-shadow-"));
    try {
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ scripts: { check: "touch script-ran; exit 42" } }),
      );
      await writeFile(
        join(project, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            types: [],
            noEmit: true,
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "Bundler",
          },
          files: ["input.ts"],
        }),
      );
      await writeFile(
        join(project, "input.ts"),
        'export const value: number = "wrong";',
      );
      const checked = spawnSync(process.execPath, bunCheckArgs(project), {
        cwd: project,
        encoding: "utf8",
        timeout: 10_000,
      });
      if (checked.error) throw checked.error;
      expect(checked.status).not.toBe(42);
      expect(diagnosticCodes(checked.stdout + checked.stderr)).toContain(2322);
      expect(access(join(project, "script-ran"))).rejects.toThrow();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  },
  20_000,
);

test.skipIf(process.env["CI"] !== "true")(
  "solution references compare real diagnostic locations across both leaf projects",
  async () => {
    const repo = process.cwd();
    const policy: unknown = JSON.parse(
      await readFile(
        resolve(repo, "packages/oxlint-config/toolchain.json"),
        "utf8",
      ),
    );
    const compiler = await resolveCompiler(repo, policy);
    const project = await mkdtemp(join(tmpdir(), "parity-solution-"));
    try {
      await writeFile(
        join(project, "tsconfig.json"),
        JSON.stringify({
          files: [],
          references: [{ path: "./first" }, { path: "./second" }],
        }),
      );
      for (const leaf of ["first", "second"]) {
        const folder = join(project, leaf);
        await mkdir(folder);
        await writeFile(
          join(folder, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              composite: true,
              types: [],
              target: "ESNext",
              module: "ESNext",
              moduleResolution: "Bundler",
            },
            files: ["input.ts"],
          }),
        );
        await writeFile(
          join(folder, "input.ts"),
          'export const value: number = "wrong";',
        );
      }
      const tsc = spawnSync(
        process.execPath,
        [
          compiler,
          "--build",
          project,
          "--noEmit",
          "--force",
          "--pretty",
          "false",
        ],
        { cwd: project, encoding: "utf8", timeout: 15_000 },
      );
      const bun = spawnSync(process.execPath, bunCheckArgs(project, true), {
        cwd: project,
        encoding: "utf8",
        timeout: 15_000,
      });
      if (tsc.error) throw tsc.error;
      if (bun.error) throw bun.error;
      const baseline = {
        status: tsc.status,
        diagnostics: diagnosticSet(tsc.stdout + tsc.stderr, project),
      };
      const candidate = {
        status: bun.status,
        diagnostics: diagnosticSet(bun.stdout + bun.stderr, project),
      };
      expect(baseline.diagnostics).toEqual([
        "first/input.ts:1:2322",
        "second/input.ts:1:2322",
      ]);
      expect(compareDiagnosticSets(baseline, candidate).passed).toBe(true);
      for (const removed of baseline.diagnostics) {
        expect(
          compareDiagnosticSets(baseline, {
            ...candidate,
            diagnostics: candidate.diagnostics.filter(
              (diagnostic) => diagnostic !== removed,
            ),
          }).passed,
        ).toBe(false);
      }
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  },
  40_000,
);
