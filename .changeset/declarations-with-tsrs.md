---
"@stll/oxlint-config": major
---

The `declaration-only-dts` Vite helper emits declarations with tsrs, which `@stll/oxlint-config` already depends on. Consumers no longer install `vite-plugin-dts`, `unplugin-dts` or TypeScript 6.0.3 for it, and can remove them.

Breaking changes:

- The helper accepts only `include`, `exclude`, `entryRoot` and `compilerOptions.declarationMap: false`. `pathsToAliases`, `strictOutput` and `declarationOnly` were vite-plugin-dts settings and are now rejected; remove them from the config.
- A package tsconfig with `compilerOptions.paths` fails the build, because declarations keep import specifiers as written. Use package imports or relative paths instead.
- Declarations are TypeScript 7's own output. Import lines keep their `type` modifiers and double quotes, and union members and inferred properties can appear in a different order. Doc comments are kept, and side-effect imports are still dropped. With `allowJs`, JavaScript inputs inside `include` now get declarations too.
