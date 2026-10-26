---
"@stll/oxlint-config": major
---

Remove `stll-typecheck-parity`: type checking is `bun check`, and consumers drop their `check:typecheck-parity` script and any CI step that runs it. `stll-typecheck-probe` stays.

The `typescript-layout` rule no longer reads install layouts (`typescriptInstallLayouts` is gone from `toolchain.json`), and the shared TypeScript 6 peer-blocker list is gone too (`typescript6Compatibility` is removed). By default no manifest, catalog, override or resolution may declare `typescript`, `@typescript/native` or an `npm:typescript@…` alias; the messages point at `bun check`, tsrs and oxc-parser. A repository that needs an install for one of its tools declares it in `typescriptAllowlist` in its own `stll-toolchain.json`, with the workspace, the declared name, the exact spec, the dependency in that workspace that needs it, and a reason; the spec may be any version, declared directly or through a catalog that resolves to it. An undeclared install fails with the entry to add, and an entry fails when its spec differs or when its workspace no longer declares the name or the dependency. Repositories that kept `typescript` 6.0.3 beside a former peer blocker add one entry per workspace. A `typescript` peer dependency, exact versions included, states support and must include the release `bun check` implements. Any `typecheck` script that invokes a compiler must use `bun check`, whether or not the package installs TypeScript.

`typescript-compat` is no longer a shared Dependabot ignore: regenerate `.github/dependabot.yml` with `stll-dependabot`, and declare an alias you keep in `dependabotIgnores`.

`stll-toolchain-check` reads tsconfig projects with tsrs instead of the consumer's `typescript` install, so a repository that declares `oxlint-tsgolint` no longer needs `typescript` for the type-aware project check.
