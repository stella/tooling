import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
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
  // The consumer installs Vite only; declarations come from the helper's own tsrs.
  writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({
      name: "reviewed-dts-profile",
      private: true,
      type: "module",
      devDependencies: { vite: "8.3.5" },
    }),
  );
  const install = spawnSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
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
    'import "./styles.css";\n/** The profile value. */\nexport const profileValue: number = 42;\n',
  );
  writeFileSync(path.join(fixture, "src", "styles.css"), "a { color: red }\n");
  writeFileSync(
    path.join(fixture, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["src"],
    }),
  );
  writeFileSync(
    path.join(fixture, "vite.config.mjs"),
    `import { defineConfig } from 'vite';
import { declarationOnlyDts } from '@stll/oxlint-config/declaration-only-dts';
export default defineConfig({ plugins: [declarationOnlyDts({ directory: import.meta.dirname, include: ['src/**/*'], entryRoot: 'src', compilerOptions: { declarationMap: false } })], build: { target: 'es2022', sourcemap: true, lib: { entry: 'src/index.ts', formats: ['es', 'cjs'], fileName: 'index' } } });\n`,
  );
  writeFileSync(
    path.join(fixture, "run-profile.mjs"),
    `import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
for (const name of ['typescript', 'vite-plugin-dts', 'unplugin-dts'])
  try { require.resolve(name); throw new Error(name + ' must not be installed'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const { build } = await import('vite');
await build({ root: import.meta.dirname, logLevel: 'warn' });
const output = path.join(import.meta.dirname, 'dist');
const files = readdirSync(output);
if (!files.includes('index.d.ts') || !files.some(file => /\\.(?:js|mjs|cjs)$/.test(file))) throw new Error('actual build did not emit JS and declarations: ' + files.join(', '));
const declaration = readFileSync(path.join(output, 'index.d.ts'), 'utf8');
if (declaration !== '/** The profile value. */\\nexport declare const profileValue: number;\\n') throw new Error('unexpected declaration output: ' + declaration);
`,
  );
  const result = spawnSync("node", [path.join(fixture, "run-profile.mjs")], {
    cwd: fixture,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Reviewed actual Vite declaration build failed: ${result.stderr}`,
    );
  process.stdout.write(
    "Reviewed Vite declaration build without TypeScript passed\n",
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
