/// <reference types="bun-types" />

import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  access,
  chmod,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  bunCheckArgs,
  compareDiagnosticSets,
  diagnosticSet,
  fixtureParity,
  fixtureRunPassed,
  fixtures,
  resolveCompiler,
  runTypecheckParity,
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
        if (!result.passed)
          console.error(
            JSON.stringify({
              configuration,
              baseline: { status: tsc.status, output: tsc.stdout + tsc.stderr },
              candidate: {
                status: bun.status,
                output: bun.stdout + bun.stderr,
              },
            }),
          );
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
  "consumer check script is rejected before compiler resolution or script execution",
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
      let failure: unknown;
      try {
        await runTypecheckParity({ repo: project, policy: {} });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      if (failure instanceof Error) {
        expect(failure.message).toContain('must not define a "check" script');
      }
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

test.skipIf(process.env["CI"] !== "true")(
  "consumer solution normalizes composite/declaration-only options and rejects lost strict-group diagnostics",
  async () => {
    const repo = process.cwd();
    const policy: unknown = JSON.parse(
      await readFile(
        resolve(repo, "packages/oxlint-config/toolchain.json"),
        "utf8",
      ),
    );
    const compiler = await resolveCompiler(repo, policy);
    const project = await realpath(
      await mkdtemp(join(tmpdir(), "parity-config-groups-")),
    );
    const logs: string[] = [];
    const errors: string[] = [];
    const errorLogger = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      },
    );
    const logger = spyOn(console, "log").mockImplementation(
      (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      },
    );
    try {
      await mkdir(join(project, "node_modules"));
      await symlink(
        resolve(compiler, "../.."),
        join(project, "node_modules/typescript"),
        "dir",
      );
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ devDependencies: { typescript: "7.0.2" } }),
      );
      await writeFile(
        join(project, "tsconfig.json"),
        JSON.stringify({
          files: [],
          references: [{ path: "./strict" }, { path: "./loose" }],
        }),
      );
      for (const leaf of ["strict", "loose"]) {
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
              strict: leaf === "strict",
              strictNullChecks: leaf === "strict",
              noUncheckedIndexedAccess: leaf === "strict",
              // Composite implies declaration; the loose leaf uses explicit declaration-only output.
              declarationDir: "./declarations",
              ...(leaf === "loose"
                ? { declaration: true, emitDeclarationOnly: true }
                : {}),
            },
            files: ["input.ts"],
          }),
        );
        await writeFile(
          join(folder, "input.ts"),
          'export const value = "valid";',
        );
      }
      const existingBuildInfo = join(project, "strict/tsconfig.tsbuildinfo");
      const newBuildInfo = join(project, "loose/tsconfig.tsbuildinfo");
      const originalBuildInfo = "pre-existing consumer build cache\n";
      await writeFile(existingBuildInfo, originalBuildInfo);
      const passed = await runTypecheckParity({ repo: project, policy });
      if (!passed)
        console.error(
          logs
            .filter(
              (line) =>
                line.includes("FAIL") || line.startsWith("Config group"),
            )
            .join("\n"),
        );
      expect(passed).toBe(true);
      expect(await readFile(existingBuildInfo, "utf8")).toBe(originalBuildInfo);
      expect(access(newBuildInfo)).rejects.toThrow();
      const strictStart = logs.findIndex(
        (line) =>
          line.startsWith("Config group ") &&
          line.includes("strict/tsconfig.json"),
      );
      const looseStart = logs.findIndex(
        (line) =>
          line.startsWith("Config group ") &&
          line.includes("loose/tsconfig.json"),
      );
      expect(strictStart).toBeGreaterThanOrEqual(0);
      expect(looseStart).toBeGreaterThan(strictStart);
      const strictRows = logs.slice(strictStart, looseStart);
      const looseRows = logs.slice(looseStart);
      for (const name of ["strict-null", "unchecked-index"]) {
        expect(
          strictRows.some(
            (line) => line.startsWith(`${name} |`) && line.endsWith("PASS"),
          ),
        ).toBe(true);
        expect(
          looseRows.some(
            (line) =>
              line.startsWith(`${name} (inactive under this config) |`) &&
              line.endsWith("INACTIVE"),
          ),
        ).toBe(true);
      }
      const wrapper = join(project, "bun-wrapper");
      await writeFile(
        wrapper,
        `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst {readFileSync}=require('node:fs');\nconst {join}=require('node:path');\nconst args=process.argv.slice(2);\nconst projectArg=args.find(arg=>arg.startsWith('--project='));\nconst folder=projectArg?.slice('--project='.length);\nif(folder&&folder.includes('unchecked-index')){\n const config=JSON.parse(readFileSync(join(folder,'tsconfig.json'),'utf8'));\n const options=config.compilerOptions;\n if(options.strictNullChecks===true&&options.noUncheckedIndexedAccess===true)process.exit(0);\n}\nconst result=spawnSync(${JSON.stringify(process.execPath)},args,{stdio:'inherit'});\nif(result.error)throw result.error;\nprocess.exit(result.status??1);\n`,
      );
      await chmod(wrapper, 0o755);
      logs.length = 0;
      expect(
        await runTypecheckParity({ repo: project, policy, bun: wrapper }),
      ).toBe(false);
      expect(await readFile(existingBuildInfo, "utf8")).toBe(originalBuildInfo);
      expect(access(newBuildInfo)).rejects.toThrow();
      expect(
        logs.some(
          (line) =>
            line.startsWith("unchecked-index |") && line.endsWith("FAIL"),
        ),
      ).toBe(true);
      expect(errors.some((line) => line.includes("zero diagnostics"))).toBe(
        true,
      );
      await writeFile(
        join(project, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            noCheck: true,
            strict: false,
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "Bundler",
            types: [],
          },
          files: ["./strict/input.ts"],
        }),
      );
      errors.length = 0;
      expect(await runTypecheckParity({ repo: project, policy })).toBe(false);
      expect(
        errors.some((line) =>
          line.includes("zero seeded fixture classes active"),
        ),
      ).toBe(true);
    } finally {
      logger.mockRestore();
      errorLogger.mockRestore();
      await rm(project, { recursive: true, force: true });
    }
  },
  180_000,
);
