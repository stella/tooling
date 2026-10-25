---
"@stll/oxlint-config": major
---

Remove `stll-typecheck-parity`: type checking is `bun check`, and consumers drop their `check:typecheck-parity` script and any CI step that runs it. `stll-typecheck-probe` stays.

The `typescript-layout` rule no longer reads install layouts (`typescriptInstallLayouts` is gone from `toolchain.json`). No manifest, catalog or resolution may declare `typescript` 7 or `@typescript/native`; the messages point at `bun check`, tsrs and oxc-parser. `typescript` 6.0.3 (or the `typescript-compat` alias) is allowed only in a package that depends on a listed peer blocker, with no root counterpart; `vite-plugin-dts` joins the peer blockers. Any `typecheck` script that invokes a compiler must use `bun check`, whether or not the package installs TypeScript.

`stll-toolchain-check` reads tsconfig projects with tsrs instead of the consumer's `typescript` install, so a repository that declares `oxlint-tsgolint` no longer needs `typescript` for the type-aware project check.
