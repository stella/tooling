import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/plugin.ts"],
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
