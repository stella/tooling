import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSync } from "oxc-parser";
import type { Plugin } from "vite";

import {
  assertDeclarationOnlyOutput,
  type ReviewedViteDtsOptions,
  reviewedViteDtsOptions,
  snapshotDeclarationDirectory,
} from "./publish-build-target-vite-dts";

type DeclarationOnlyDtsOptions = { directory: string } & ReviewedViteDtsOptions;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Side-effect imports name runtime modules (often styles) that declarations cannot resolve. */
export const withoutSideEffectImports = (file: string, source: string) => {
  const { program, errors } = parseSync(file, source, {
    lang: "dts",
    sourceType: "module",
  });
  if (errors.length > 0)
    throw new Error(
      `Emitted declaration ${file} does not parse: ${errors[0]?.message ?? ""}`,
    );
  let result = source;
  for (const statement of program.body.toReversed()) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.importKind === "type" ||
      statement.specifiers.length > 0
    )
      continue;
    const end = /^\r?\n/.exec(result.slice(statement.end))?.[0].length ?? 0;
    result =
      result.slice(0, statement.start) + result.slice(statement.end + end);
  }
  return result;
};

const commonDirectory = (files: readonly string[]) => {
  const directories = files.map((file) => path.dirname(file).split(path.sep));
  const first = directories.at(0);
  if (first === undefined)
    throw new Error("Declaration emit found no TypeScript inputs");
  let length = first.length;
  for (const parts of directories)
    while (
      parts.slice(0, length).join(path.sep) !==
      first.slice(0, length).join(path.sep)
    )
      length -= 1;
  return first.slice(0, length).join(path.sep);
};

const run = (args: string[], cwd: string) =>
  new Promise<{ status: number; output: string }>((resolve, reject) => {
    execFile(
      process.execPath,
      [
        path.join(
          path.dirname(
            createRequire(import.meta.url).resolve("tsrs/package.json"),
          ),
          "bin",
          "tsrs",
        ),
        ...args,
      ],
      { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 300_000 },
      (error, stdout, stderr) => {
        const status = error === null ? 0 : error.code;
        if (typeof status !== "number")
          reject(error ?? new Error("tsrs failed"));
        else resolve({ status, output: `${stdout}${stderr}`.trim() });
      },
    );
  });

type EmitDeclarationsOptions = {
  root: string;
  output: string;
  options: ReviewedViteDtsOptions;
  warn: (message: string) => void;
};
/** tsrs emits declarations for the package tsconfig into the build output; nothing else may change. */
export const emitDeclarations = async ({
  root,
  output,
  options,
  warn,
}: EmitDeclarationsOptions) => {
  const base = path.join(root, "tsconfig.json");
  if (!existsSync(base))
    throw new Error("Declaration emit requires the package tsconfig.json");
  const scratch = mkdtempSync(path.join(tmpdir(), "stll-declarations-"));
  const config = path.join(scratch, "tsconfig.json");
  const absolute = (patterns: readonly string[]) =>
    patterns.map((pattern) => path.join(root, pattern));
  const compilerOptions: Record<string, unknown> = {
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    noEmitOnError: false,
    noUnusedLocals: false,
    noUnusedParameters: false,
    // The bundler resolves style and asset imports; their declarations are dropped below.
    noUncheckedSideEffectImports: false,
    outDir: output,
    declarationDir: null,
    outFile: null,
    composite: false,
    incremental: false,
    tsBuildInfoFile: null,
    ...options.compilerOptions,
  };
  const project = {
    extends: base,
    compilerOptions,
    ...(options.include === undefined
      ? {}
      : { files: [], include: absolute(options.include) }),
    ...(options.exclude === undefined
      ? {}
      : { exclude: absolute(options.exclude) }),
  };
  const { API } = await import("tsrs/unstable/async");
  const api = new API({ cwd: root });
  try {
    writeFileSync(config, JSON.stringify(project));
    const parsed = await api.parseConfigFile(config);
    const error = parsed.errors.at(0);
    if (error !== undefined)
      throw new Error(
        `Declaration emit cannot read ${base}: TS${error.code} ${error.text}`,
      );
    const paths: unknown = parsed.options.paths;
    if (record(paths) && Object.keys(paths).length > 0)
      throw new Error(
        "Declaration emit keeps import specifiers as written; replace compilerOptions.paths aliases with package imports or relative paths",
      );
    compilerOptions["rootDir"] =
      options.entryRoot === undefined
        ? commonDirectory(
            parsed.fileNames.filter((file) => !/\.d\.[cm]?ts$/.test(file)),
          )
        : path.join(root, options.entryRoot);
    writeFileSync(config, JSON.stringify(project));
    const before = snapshotDeclarationDirectory(output);
    const { status, output: diagnostics } = await run(
      ["-p", config, "--pretty", "false"],
      root,
    );
    // Exit 2 reports type diagnostics with outputs written. Compiler option and output
    // errors (TS5xxx), inputs outside rootDir or the project, and no inputs stop the build.
    if (
      status !== 0 &&
      (status !== 2 || /TS(?:5\d{3}|6059|6307|18003):/.test(diagnostics))
    )
      throw new Error(`Declaration emit failed:\n${diagnostics}`);
    if (status === 2) warn(`Declaration emit diagnostics:\n${diagnostics}`);
    const after = snapshotDeclarationDirectory(output);
    assertDeclarationOnlyOutput({ before, after });
    for (const [file, digest] of Object.entries(after)) {
      if (before[file] === digest || !/\.d\.[cm]?ts$/.test(file)) continue;
      const target = path.join(output, file);
      writeFileSync(
        target,
        withoutSideEffectImports(file, readFileSync(target, "utf8")),
      );
    }
  } finally {
    await api.close();
    rmSync(scratch, { recursive: true, force: true });
  }
};

/** The actual build uses this closed factory; tsrs writes only declarations after the bundle. */
export const declarationOnlyDts = ({
  directory,
  ...options
}: DeclarationOnlyDtsOptions): Plugin => {
  const root = realpathSync(directory);
  const reviewed = reviewedViteDtsOptions(options);
  let output: string | undefined;
  let emitted = false;
  return {
    name: "stll:declaration-only-dts",
    apply: "build",
    enforce: "pre",
    configResolved(config) {
      if (
        realpathSync(config.root) !== root ||
        config.build.write === false ||
        config.build.watch
      )
        throw new Error(
          "Declaration-only adapter requires a package-local production build",
        );
      const resolved = path.resolve(root, config.build.outDir);
      const relative = path.relative(root, resolved);
      if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error(
          "Declaration output directory must stay within the package",
        );
      // Check existing ancestor paths before declarations are written.
      let ancestor = resolved;
      while (ancestor !== root) {
        try {
          const within = path.relative(root, realpathSync(ancestor));
          if (
            within === ".." ||
            within.startsWith(`..${path.sep}`) ||
            path.isAbsolute(within)
          )
            throw new Error("Declaration output directory leaves the package");
          break;
        } catch (error) {
          if (!record(error) || error["code"] !== "ENOENT") throw error;
          ancestor = path.dirname(ancestor);
        }
      }
      output = resolved;
    },
    writeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        // Every output format shares one outDir; declarations are emitted once.
        if (emitted) return;
        emitted = true;
        if (output === undefined)
          throw new Error("Declaration output directory was not resolved");
        await emitDeclarations({
          root,
          output,
          options: reviewed,
          warn: (message) => this.warn(message),
        });
      },
    },
  };
};
