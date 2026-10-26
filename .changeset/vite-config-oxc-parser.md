---
"@stll/oxlint-config": patch
---

The Vite publish target resolver reads the declaration helper's config with oxc-parser instead of stripping TypeScript with esbuild and parsing with acorn, so `esbuild` is no longer a direct dependency. A config that exports `defineConfig(...)` through a local constant is now recognized, and a value import of `vite-plugin-dts` or `unplugin-dts` beside the helper fails even when unused.
