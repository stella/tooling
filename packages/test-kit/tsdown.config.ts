import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    bun: "src/bun.ts",
    vitest: "src/vitest.ts",
    "db-clock": "src/db-clock.ts",
    "bun/forbid-network": "src/bun/forbid-network.ts",
    "vitest/forbid-network": "src/vitest/forbid-network.ts",
  },
  format: ["esm"],
  deps: { neverBundle: ["bun:test"] },
  dts: true,
  clean: true,
  sourcemap: true,
  hash: false,
});
