import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This installs only an isolated CI fixture; it never modifies the checkout's dependency graph.
if (process.env["CI"] !== "true")
  throw new Error("Build profile integration runs only in CI");
const repository = fileURLToPath(new URL("../", import.meta.url));
const fixture = mkdtempSync(path.join(tmpdir(), "stll-vite-dts-profile-"));
try {
  writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({
      name: "reviewed-dts-profile",
      private: true,
      type: "module",
      devDependencies: {
        vite: "8.1.5",
        "vite-plugin-dts": "5.0.3",
        "unplugin-dts": "1.0.3",
        typescript: "6.0.3",
      },
    }),
  );
  const install = spawnSync(
    "npm",
    [
      "install",
      "--legacy-peer-deps",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    {
      cwd: fixture,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (install.error || install.status !== 0)
    throw new Error(
      `Isolated Vite profile install failed: ${install.error?.message ?? install.stderr}`,
    );
  mkdirSync(path.join(fixture, "node_modules", "@stll"), { recursive: true });
  symlinkSync(
    path.join(repository, "packages", "oxlint-config"),
    path.join(fixture, "node_modules", "@stll", "oxlint-config"),
    "dir",
  );
  mkdirSync(path.join(fixture, "src"));
  writeFileSync(
    path.join(fixture, "src", "index.ts"),
    "export const profileValue: number = 42;\n",
  );
  writeFileSync(
    path.join(fixture, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        declaration: true,
        skipLibCheck: true,
      },
      include: ["src"],
    }),
  );
  writeFileSync(
    path.join(fixture, "vite.config.mjs"),
    `import { defineConfig } from 'vite';
import { declarationOnlyDts } from '@stll/oxlint-config/declaration-only-dts';
export default defineConfig({ plugins: [declarationOnlyDts({ directory: import.meta.dirname, include: ['src/**/*'], entryRoot: 'src', compilerOptions: { declarationMap: false } })], build: { target: 'es2022', sourcemap: true, lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'index' } } });\n`,
  );
  writeFileSync(
    path.join(fixture, "run-profile.mjs"),
    `import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const mutate = process.argv.includes('--mutate-dts');
const emitJavaScript = process.argv.includes('--emit-js');
const emitDeclaration = process.argv.includes('--emit-declaration');
if (mutate || emitJavaScript || emitDeclaration) {
  const loaded = require('vite-plugin-dts');
  const factory = loaded.default;
  loaded.default = options => {
    const plugin = factory(options);
    if (mutate) {
      const original = plugin.writeBundle;
      plugin.writeBundle = async function (...args) {
        await original.apply(this, args);
        const output = path.join(import.meta.dirname, 'dist');
        const file = readdirSync(output).find(file => /\\.(?:js|mjs|cjs)$/.test(file));
        if (!file) throw new Error('missing JavaScript output before declaration mutation');
        writeFileSync(path.join(output, file), 'export const changedByDeclaration = true;');
      };
    } else {
      const original = plugin.buildStart;
      const handler = typeof original === 'function' ? original : original?.handler;
      if (original !== undefined && typeof handler !== 'function') throw new Error('Unsupported declaration buildStart hook');
      plugin.buildStart = async function (...args) {
        if (handler) await handler.apply(this, args);
        this.emitFile({ type: 'asset', fileName: emitJavaScript ? 'extra.js' : 'index-extra.d.ts', source: emitJavaScript ? 'export const extra = true;' : 'export declare const extra: boolean;' });
      };
    }
    return plugin;
  };
}
const { build } = await import('vite');
await build({ root: import.meta.dirname });
const output = path.join(import.meta.dirname, 'dist');
const files = readdirSync(output);
if (!files.includes('index.d.ts') || !files.some(file => /\\.(?:js|mjs|cjs)$/.test(file))) throw new Error('actual build did not emit JS and declarations');
if (!readFileSync(path.join(output, 'index.d.ts'), 'utf8').includes('profileValue')) throw new Error('missing actual generated declaration');
if (emitDeclaration && (!files.includes('index-extra.d.ts') || !readFileSync(path.join(output, 'index-extra.d.ts'), 'utf8').includes('extra: boolean'))) throw new Error('missing extra declaration emitted through buildStart');
`,
  );
  for (const mode of [
    "normal",
    "mutate-dts",
    "emit-js",
    "emit-declaration",
  ] as const) {
    const args = [path.join(fixture, "run-profile.mjs")];
    if (mode !== "normal") args.push(`--${mode}`);
    const result = spawnSync("node", args, {
      cwd: fixture,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (
      (mode === "normal" || mode === "emit-declaration") &&
      result.status !== 0
    )
      throw new Error(
        `Reviewed actual Vite/dts build failed: ${result.stderr}`,
      );
    if (
      mode === "mutate-dts" &&
      (result.status === 0 ||
        !result.stderr.includes(
          "Declaration plugin changed non-declaration output",
        ))
    )
      throw new Error(
        `Actual declaration hook mutation was not rejected: ${result.stderr}`,
      );
    if (
      mode === "emit-js" &&
      (result.status === 0 ||
        !/Declaration plugin|declaration-only (?:plugin|output|asset|hook|profile)/.test(
          result.stderr,
        ))
    )
      throw new Error(
        `Actual declaration hook JavaScript asset emission was not rejected: ${result.stderr}`,
      );
  }
  process.stdout.write(
    "Reviewed Vite/dts actual build and JavaScript immutability passed\n",
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
