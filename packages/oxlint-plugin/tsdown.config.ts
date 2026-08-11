import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/no-any-casts.ts",
    "src/no-dangerous-type-assertions.ts",
    "src/no-partial-record-satisfies.ts",
    "src/no-unsafe-inner-html.ts",
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
