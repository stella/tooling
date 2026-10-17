import { defineConfig } from "tsdown";

// Bun-only (the kit wraps `bun:test` hooks and `Bun.connect`), so ESM only.
export default defineConfig({
  entry: ["src/index.ts", "src/db-clock.ts", "src/forbid-network.ts"],
  format: ["esm"],
  target: "esnext",
  dts: true,
  clean: true,
  sourcemap: true,
  hash: false,
  deps: { neverBundle: [/^bun:/u] },
});
