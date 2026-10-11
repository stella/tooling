import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/plugin.ts",
    "src/no-raw-colors.ts",
    "src/toolchain-check-cli.ts",
    "src/cloud-setup-cli.ts",
    "src/publish-contract-cli.ts",
    "src/publish-build-target-nuxt-helper.ts",
    "src/consumer-compat-cli.ts",
    "src/typecheck-parity-cli.ts",
    "src/toolchain-changed-cli.ts",
    "src/typecheck-probe-cli.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
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
