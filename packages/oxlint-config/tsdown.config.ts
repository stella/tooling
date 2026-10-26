import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "tsdown";

// About 200 exported declarations here rely on inferred types, which the oxc
// generator cannot emit; tsrs emits them from the program instead.
const tsrs = path.join(
  path.dirname(createRequire(import.meta.url).resolve("tsrs/package.json")),
  "bin/tsrs",
);

export default defineConfig({
  define: {
    STLL_RUST_TEMPLATES: JSON.stringify(
      Object.fromEntries(
        [
          "cargo-root.toml",
          "cargo-workspace.toml",
          "cargo-config.toml",
          "rustfmt.toml",
          "clippy.toml",
        ].map((name) => [
          name,
          readFileSync(new URL(`../../rust/${name}`, import.meta.url), "utf8"),
        ]),
      ),
    ),
  },
  entry: [
    "src/rust-policy-cli.ts",
    "src/index.ts",
    "src/quarantine-cli.ts",
    "src/quarantine-policy.ts",
    "src/plugin.ts",
    "src/no-raw-colors.ts",
    "src/toolchain-check-cli.ts",
    "src/dependabot-cli.ts",
    "src/dependabot.ts",
    "src/engine-support.ts",
    "src/engine-support-cli.ts",
    "src/cloud-setup-cli.ts",
    "src/publish-contract-cli.ts",
    "src/publish-build-target-nuxt-helper.ts",
    "src/publish-build-target-vite-dts-helper.ts",
    "src/consumer-compat-cli.ts",
    "src/toolchain-changed-cli.ts",
    "src/typecheck-probe-cli.ts",
    "src/wasi-loader-normalizer-cli.ts",
  ],
  format: ["esm", "cjs"],
  dts: { generator: "tsgo", tsgo: { path: tsrs } },
  clean: true,
  sourcemap: true,
  hash: false,
  checks: {
    legacyCjs: false,
  },
  outputOptions: {
    exports: "named",
  },
});
