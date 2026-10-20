import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/no-any-casts.ts",
    "src/no-dangerous-type-assertions.ts",
    "src/no-partial-record-satisfies.ts",
    "src/no-unsafe-inner-html.ts",
    "src/no-raw-route-query-client.ts",
    "src/require-loader-prefetch.ts",
    "src/no-wall-clock-in-tests.ts",
    "src/no-real-timer-waits-in-tests.ts",
    "src/no-unseeded-random-in-tests.ts",
    "src/no-real-network-in-tests.ts",
    "src/no-checkout-writes-in-tests.ts",
    "src/no-wall-clock-bound.ts",
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
