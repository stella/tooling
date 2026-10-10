/// <reference types="bun-types" />

import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
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
  compareRepository,
  discoverConfigGroups,
  diagnosticSet,
  fixtureCompilerOptions,
  fixturePackageContext,
  fixtureParity,
  fixtureRunPassed,
  fixtures,
  resolveCompiler,
  runTypecheckParity,
} from "./typecheck-parity";

const rejectedError = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Promise rejected without an Error", { cause: error });
  }
  throw new Error("Expected promise rejection");
};

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
          { cwd: project, encoding: "utf8", timeout: 10_000 },
        );
        const bun = spawnSync(process.execPath, bunCheckArgs(project), {
          cwd: project,
          encoding: "utf8",
          timeout: 10_000,
        });
        if (tsc.error) throw tsc.error;
        if (bun.error) throw bun.error;
        const result = fixtureParity({
          repo: project,
          seedFiles: Object.keys(fixture.files),
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
              repo: project,
              seedFiles: Object.keys(fixture.files),
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
      expect(
        await rejectedError(access(join(project, "script-ran"))),
      ).toBeInstanceOf(Error);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  },
  20_000,
);

test.skipIf(process.env["CI"] !== "true")(
  "dependent composite projects compare original source diagnostics without consumer outputs",
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
      await mkdtemp(join(tmpdir(), "parity-dependent-solution-")),
    );
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
              rootDir: ".",
              outDir: "./dist",
              tsBuildInfoFile: "./dist/tsconfig.tsbuildinfo",
            },
            files: ["input.ts"],
            ...(leaf === "second"
              ? { references: [{ path: "../first" }] }
              : {}),
          }),
        );
        await writeFile(
          join(folder, "input.ts"),
          leaf === "first"
            ? "export const value: number = 1;"
            : 'import { value } from "../first/input.js"; export const result: number = value;',
        );
      }
      const existingOutput = join(project, "first/dist/input.js");
      const existingBuildInfo = join(
        project,
        "first/dist/tsconfig.tsbuildinfo",
      );
      await mkdir(join(project, "first/dist"));
      const outputSentinel = "// consumer output must remain unchanged\n";
      const buildSentinel = "consumer build cache must remain unchanged\n";
      await writeFile(existingOutput, outputSentinel);
      await writeFile(existingBuildInfo, buildSentinel);
      const originalFiles = (
        await readdir(project, { recursive: true })
      ).sort();
      for (const seeded of [false, true]) {
        await writeFile(
          join(project, "first/input.ts"),
          seeded
            ? 'export const value: number = "wrong";'
            : "export const value: number = 1;",
        );
        const graph = discoverConfigGroups({ repo: project, compiler });
        expect(graph.build).toBe(true);
        const compared = await compareRepository({
          repo: project,
          compiler,
          bun: process.execPath,
          graph,
        });
        const baseline = {
          status: compared.baseline.status,
          diagnostics: diagnosticSet(compared.baseline.output, project),
        };
        const candidate = {
          status: compared.candidate.status,
          diagnostics: diagnosticSet(compared.candidate.output, project),
        };
        const expected = seeded ? ["first/input.ts:1:2322"] : [];
        expect(baseline.diagnostics).toEqual(expected);
        expect(candidate.diagnostics).toEqual(expected);
        expect(compared.baseline.rawStatus).toBe(seeded ? 2 : 0);
        expect(compared.candidate.rawStatus).toBe(seeded ? 1 : 0);
        expect(baseline.status).toBe(candidate.status);
        if (seeded) expect(baseline.status).not.toBe(0);
        else expect(baseline.status).toBe(0);
        expect(compared.repository.passed).toBe(true);
        expect(compareDiagnosticSets(baseline, candidate).passed).toBe(true);
        if (seeded) {
          expect(
            compareDiagnosticSets(baseline, { ...candidate, diagnostics: [] })
              .passed,
          ).toBe(false);
          expect(
            compareDiagnosticSets(baseline, { ...candidate, status: 0 }).passed,
          ).toBe(false);
        }
        expect(await readFile(existingOutput, "utf8")).toBe(outputSentinel);
        expect(await readFile(existingBuildInfo, "utf8")).toBe(buildSentinel);
        expect((await readdir(project, { recursive: true })).sort()).toEqual(
          originalFiles,
        );
        expect(
          await rejectedError(access(join(project, "second/dist"))),
        ).toBeInstanceOf(Error);
      }
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  },
  60_000,
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
        throw new Error(
          errors.join("\n") +
            "\n" +
            logs
              .filter(
                (line) =>
                  line.includes("FAIL") || line.startsWith("Config group"),
              )
              .join("\n"),
        );
      expect(passed).toBe(true);
      expect(await readFile(existingBuildInfo, "utf8")).toBe(originalBuildInfo);
      expect(await rejectedError(access(newBuildInfo))).toBeInstanceOf(Error);
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
      expect(await rejectedError(access(newBuildInfo))).toBeInstanceOf(Error);
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

test.skipIf(process.env["CI"] !== "true")(
  "NodeNext fixtures preserve the nearest consumer package module context",
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
      await mkdtemp(join(tmpdir(), "parity-package-context-")),
    );
    try {
      const consumer = join(project, "consumer");
      const configPath = join(consumer, "packages/app/tsconfig.json");
      const fixtureFolder = join(project, "fixture");
      await mkdir(join(consumer, "packages/app"), { recursive: true });
      await mkdir(fixtureFolder);
      await writeFile(
        join(consumer, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      const compilerOptions = {
        types: [],
        target: "ESNext",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        moduleDetection: "auto",
        noUnusedLocals: true,
      };
      await writeFile(configPath, JSON.stringify({ compilerOptions }));
      const context = fixturePackageContext(configPath);
      expect(context).toEqual({ type: "module" });
      await writeFile(
        join(fixtureFolder, "package.json"),
        JSON.stringify(context),
      );
      await writeFile(
        join(fixtureFolder, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: fixtureCompilerOptions({
            compilerOptions,
            configPath,
          }),
          files: ["input.ts"],
        }),
      );
      const fixture = fixtures.find(({ name }) => name === "module-detection");
      if (fixture === undefined)
        throw new Error("Missing module-detection fixture");
      for (const [name, source] of Object.entries(fixture.files)) {
        await writeFile(join(fixtureFolder, name), source);
      }
      for (const contextPresent of [true, false]) {
        if (!contextPresent) await rm(join(fixtureFolder, "package.json"));
        const tsc = spawnSync(
          process.execPath,
          [
            compiler,
            "--noEmit",
            "--pretty",
            "false",
            "--project",
            fixtureFolder,
          ],
          { cwd: fixtureFolder, encoding: "utf8", timeout: 10_000 },
        );
        const bun = spawnSync(process.execPath, bunCheckArgs(fixtureFolder), {
          cwd: fixtureFolder,
          encoding: "utf8",
          timeout: 10_000,
        });
        if (tsc.error) throw tsc.error;
        if (bun.error) throw bun.error;
        const result = fixtureParity({
          repo: fixtureFolder,
          seedFiles: Object.keys(fixture.files),
          expected: fixture.codes,
          match: "all",
          baseline: { status: tsc.status, output: tsc.stdout + tsc.stderr },
          candidate: { status: bun.status, output: bun.stdout + bun.stderr },
        });
        expect(result.tscCodes).toEqual(contextPresent ? [6133] : []);
        expect(result.bunCodes).toEqual(result.tscCodes);
        expect(result.active).toBe(contextPresent);
        expect(result.passed).toBe(true);
      }
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  },
  50_000,
);

test.skipIf(process.env["CI"] !== "true")(
  "real parity skips inadmissible JavaScript inputs and checks admitted inputs",
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
      await mkdtemp(join(tmpdir(), "parity-input-kinds-")),
    );
    const logs: string[] = [];
    const errors: string[] = [];
    const logger = spyOn(console, "log").mockImplementation(
      (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      },
    );
    const errorLogger = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
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
      await writeFile(join(project, "input.ts"), "export const value = 1;");
      for (const allowJs of [undefined, false, true]) {
        logs.length = 0;
        errors.length = 0;
        await writeFile(
          join(project, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              target: "ESNext",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true,
              types: [],
              ...(allowJs === undefined ? {} : { allowJs }),
              ...(allowJs === true ? { checkJs: true } : {}),
            },
            files: ["input.ts"],
          }),
        );
        const passed = await runTypecheckParity({ repo: project, policy });
        if (!passed)
          throw new Error(
            [...errors, ...logs.filter((line) => line.includes("FAIL"))].join(
              "\n",
            ),
          );
        expect(passed).toBe(true);
        const row = logs.find((line) => line.startsWith("checked-javascript"));
        if (row === undefined)
          throw new Error("Missing JavaScript fixture row");
        expect(row.endsWith(allowJs === true ? "PASS" : "INACTIVE")).toBe(true);
        expect(errors).toEqual([]);
      }
    } finally {
      logger.mockRestore();
      errorLogger.mockRestore();
      await rm(project, { recursive: true, force: true });
    }
  },
  120_000,
);

test.skipIf(process.env["CI"] !== "true")(
  "shared temporary graphs resolve root and workspace types for repository and active fixtures",
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
      await mkdtemp(join(tmpdir(), "parity-repository-types-")),
    );
    try {
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ devDependencies: { typescript: "7.0.2" } }),
      );
      await symlink(
        join(repo, "node_modules"),
        join(project, "node_modules"),
        "dir",
      );
      const leaf = join(project, "workspace");
      const localTypes = join(leaf, "node_modules/workspace-test-types");
      await mkdir(localTypes, { recursive: true });
      await writeFile(
        join(localTypes, "package.json"),
        JSON.stringify({ name: "workspace-test-types", types: "index.d.ts" }),
      );
      await writeFile(
        join(localTypes, "index.d.ts"),
        "declare const workspaceValue: string;",
      );
      await writeFile(
        join(project, "tsconfig.json"),
        JSON.stringify({ files: [], references: [{ path: "./workspace" }] }),
      );
      await writeFile(
        join(leaf, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            composite: true,
            strict: true,
            skipLibCheck: true,
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "Bundler",
            types: ["bun-types", "workspace-test-types"],
          },
          files: ["input.ts"],
        }),
      );
      for (const seeded of [false, true]) {
        await writeFile(
          join(leaf, "input.ts"),
          seeded
            ? "export const value: typeof Bun.version = 42;"
            : "export const value: typeof Bun.version = workspaceValue;",
        );
        const compared = await compareRepository({
          repo: project,
          compiler,
          bun: process.execPath,
          graph: discoverConfigGroups({ repo: project, compiler }),
        });
        if (!compared.repository.passed)
          throw new Error(
            compared.baseline.output + "\n" + compared.candidate.output,
          );
        expect(compared.repository.passed).toBe(true);
        expect(compared.repository.configurationDiagnostics).toEqual([]);
        const expected = seeded ? ["workspace/input.ts:1:2322"] : [];
        expect(compared.baseline.diagnostics).toEqual(expected);
        expect(compared.candidate.diagnostics).toEqual(expected);
      }
      await writeFile(
        join(leaf, "input.ts"),
        "export const value: typeof Bun.version = workspaceValue;",
      );
      const logs: string[] = [];
      const errors: string[] = [];
      const logger = spyOn(console, "log").mockImplementation(
        (...args: unknown[]) => {
          logs.push(args.map(String).join(" "));
        },
      );
      const errorLogger = spyOn(console, "error").mockImplementation(
        (...args: unknown[]) => {
          errors.push(args.map(String).join(" "));
        },
      );
      try {
        const passed = await runTypecheckParity({ repo: project, policy });
        if (!passed)
          throw new Error(
            [...errors, ...logs.filter((line) => line.includes("FAIL"))].join(
              "\n",
            ),
          );
        expect(passed).toBe(true);
        expect(errors).toEqual([]);
        expect(
          logs.some(
            (line) =>
              line.startsWith("type-mismatch |") && line.endsWith("PASS"),
          ),
        ).toBe(true);
        expect(logs.some((line) => line.includes("configuration error"))).toBe(
          false,
        );
      } finally {
        logger.mockRestore();
        errorLogger.mockRestore();
      }
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(process.env["CI"] !== "true")(
  "temporary repository configs preserve explicit and default original source roots",
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
      await mkdtemp(join(tmpdir(), "parity-original-source-roots-")),
    );
    try {
      await mkdir(join(project, "src"));
      await writeFile(join(project, "src/value.ts"), "export const value = 1;");
      for (const rootDir of [undefined, "./src"]) {
        await writeFile(
          join(project, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              noEmit: true,
              types: [],
              target: "ESNext",
              module: "ESNext",
              moduleResolution: "Bundler",
              rootDirs: ["./src"],
              paths: { "@/*": ["./src/*"] },
              ...(rootDir === undefined ? {} : { rootDir }),
            },
            files: ["./src/input.ts", "./src/value.ts"],
          }),
        );
        for (const seeded of [false, true]) {
          await writeFile(
            join(project, "src/input.ts"),
            seeded
              ? 'import { value } from "@/value"; export const result: string = value;'
              : 'import { value } from "@/value"; export const result: number = value;',
          );
          const compared = await compareRepository({
            repo: project,
            compiler,
            bun: process.execPath,
            graph: discoverConfigGroups({ repo: project, compiler }),
          });
          if (!compared.repository.passed)
            throw new Error(
              compared.baseline.output + "\n" + compared.candidate.output,
            );
          expect(compared.repository.passed).toBe(true);
          expect(compared.repository.configurationDiagnostics).toEqual([]);
          const expected = seeded ? ["src/input.ts:1:2322"] : [];
          expect(compared.baseline.diagnostics).toEqual(expected);
          expect(compared.candidate.diagnostics).toEqual(expected);
        }
      }
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(process.env["CI"] !== "true")(
  "solution root preserves noEmit and TypeScript extension imports while referenced leaves emit declarations",
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
      await mkdtemp(join(tmpdir(), "parity-noemit-root-")),
    );
    try {
      await mkdir(join(project, "leaf"));
      const options = {
        types: [],
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
      };
      await writeFile(
        join(project, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            ...options,
            noEmit: true,
            allowImportingTsExtensions: true,
          },
          files: ["input.ts"],
          references: [{ path: "./leaf" }],
        }),
      );
      await writeFile(
        join(project, "leaf/tsconfig.json"),
        JSON.stringify({
          compilerOptions: { ...options, composite: true },
          files: ["input.ts"],
        }),
      );
      await writeFile(
        join(project, "leaf/input.ts"),
        "export const value: number = 1;",
      );
      for (const seeded of [false, true]) {
        await writeFile(
          join(project, "input.ts"),
          seeded
            ? 'import { value } from "./leaf/input.ts"; export const result: string = value;'
            : 'import { value } from "./leaf/input.ts"; export const result: number = value;',
        );
        const compared = await compareRepository({
          repo: project,
          compiler,
          bun: process.execPath,
          graph: discoverConfigGroups({ repo: project, compiler }),
        });
        if (!compared.repository.passed)
          throw new Error(
            compared.baseline.output + "\n" + compared.candidate.output,
          );
        expect(compared.repository.passed).toBe(true);
        expect(compared.repository.configurationDiagnostics).toEqual([]);
        const expected = seeded ? ["input.ts:1:2322"] : [];
        expect(compared.baseline.diagnostics).toEqual(expected);
        expect(compared.candidate.diagnostics).toEqual(expected);
      }
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(process.env["CI"] !== "true")(
  "original and temporary configs have equivalent diagnostics with omitted rootDir and outside sources",
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
      await mkdtemp(join(tmpdir(), "parity-rootdir-equivalence-")),
    );
    const consumer = join(project, "app");
    try {
      await mkdir(consumer);
      await writeFile(join(project, "shared.ts"), "export const shared = 1;");
      for (const configuration of [
        {},
        { outDir: "./dist" },
        { declaration: true, declarationDir: "./types" },
        { outFile: "./dist.js" },
        { incremental: true, tsBuildInfoFile: "./cache.tsbuildinfo" },
        { composite: true, tsBuildInfoFile: "./cache.tsbuildinfo" },
        {
          declaration: true,
          declarationDir: "./types",
          incremental: true,
          tsBuildInfoFile: "./cache.tsbuildinfo",
        },
        { composite: true },
      ]) {
        for (const outside of [false, true]) {
          await writeFile(
            join(consumer, "tsconfig.json"),
            JSON.stringify({
              compilerOptions: {
                noEmit: true,
                types: [],
                target: "ESNext",
                module: "ESNext",
                moduleResolution: "Bundler",
                ...configuration,
              },
              files: outside ? ["input.ts", "../shared.ts"] : ["input.ts"],
            }),
          );
          for (const seeded of [false, true]) {
            await writeFile(
              join(consumer, "input.ts"),
              seeded
                ? 'export const value: number = "wrong";'
                : "export const value: number = 1;",
            );
            const original = spawnSync(
              process.execPath,
              [
                compiler,
                "--noEmit",
                "--pretty",
                "false",
                "--project",
                join(consumer, "tsconfig.json"),
              ],
              { cwd: consumer, encoding: "utf8", timeout: 10_000 },
            );
            if (original.error) throw original.error;
            const originalOutput = original.stdout + original.stderr;
            const compared = await compareRepository({
              repo: consumer,
              compiler,
              bun: process.execPath,
              graph: discoverConfigGroups({ repo: consumer, compiler }),
            });
            const expected = diagnosticSet(originalOutput, consumer);
            const actual = diagnosticSet(compared.baseline.output, consumer);
            // TS7 removed outFile; the temporary config must retain its rejection.
            if ("outFile" in configuration) {
              expect(original.status).toBe(1);
              expect(compared.baseline.rawStatus).toBe(1);
              expect([...new Set(originalOutput.match(/TS\d+/g))]).toEqual([
                "TS5102",
              ]);
              expect([
                ...new Set(compared.baseline.output.match(/TS\d+/g)),
              ]).toEqual(["TS5102"]);
              expect(compared.repository.passed).toBe(false);
              continue;
            }
            if (JSON.stringify(actual) !== JSON.stringify(expected))
              throw new Error(
                `Configuration: ${JSON.stringify({ configuration, outside, seeded })}\nOriginal diagnostics:\n${originalOutput}\nTemporary diagnostics:\n${compared.baseline.output}`,
              );
            expect(actual).toEqual(expected);
            expect(original.status).not.toBeNull();
            expect(original.status === 0).toBe(
              compared.baseline.rawStatus === 0,
            );
            if (!originalOutput.includes("TS6059"))
              expect(
                expected.some((diagnostic) => diagnostic.includes(":2322")),
              ).toBe(seeded);
            if (!outside)
              expect(
                expected.some((diagnostic) => diagnostic.includes(":6059")),
              ).toBe(false);
            expect(compared.baseline.output.includes("TS6059")).toBe(
              originalOutput.includes("TS6059"),
            );
          }
        }
      }
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  },
  60_000,
);
