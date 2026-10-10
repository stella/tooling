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
    "src/publish-build-target-vite-dts-helper.ts",
    "src/consumer-compat-cli.ts",
    "src/typecheck-parity-cli.ts",
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
