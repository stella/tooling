<p align="center">
  <img src=".github/assets/banner.png" alt="Stella tooling" width="100%" />
</p>

# stella tooling

Shared TypeScript, oxlint, and Rust configuration for stella public packages.

This repo intentionally contains only portable tooling policy:

- `@stll/typescript-config`: strict TypeScript config presets.
- `@stll/oxlint-config`: general upstream oxlint rules and the shared
  `stella-lowercase` and `no-raw-colors` JS plugins.
- `@stll/oxlint-plugin`: portable static-safety rules for unsafe type
  assertions, incomplete union-keyed records, raw DOM HTML sinks, and
  route-query waterfalls.
- `rust/`: source-of-truth Rust formatting, lint, and Cargo profile templates.
- `rust-lints/`: Dylint libraries for stella-specific Rust rules.

Repo-specific stella rules stay in the consuming repo: domain authorization,
i18n, generated native artifacts, benchmark exceptions, and package-specific
ignores. Route-query conventions are shared here because they are the common
TanStack Router + React Query contract.

## Bun version

`@stll/oxlint-config/toolchain.json` owns the shared Bun version. Install
`@stll/oxlint-config` as a dev dependency and align `packageManager` and
`bun-types` with its `bun` field. Configure `oven-sh/setup-bun` with
`bun-version-file: package.json`, then run `bunx --no-install stll-toolchain-check`
from the repository root in CI. The check covers tracked manifests, workflows,
Dockerfiles, and version-manager files. A non-Bun manifest requires an explicit
`--allow-non-bun-package-manager path/to/package.json` exception.

## Usage

Install the shared TypeScript and oxlint packages:

```bash
bun add -d @stll/typescript-config @stll/oxlint-config @stll/oxlint-plugin @oxlint/plugins oxlint oxlint-tsgolint typescript
```

The shared defaults require TypeScript 7.0.2 or newer, oxlint 1.80.0 or
newer, and oxlint-tsgolint 7.0.2001 or newer. Pin the current versions from
`@stll/oxlint-config/toolchain.json`; do not use the deprecated
oxlint-tsgolint 0.x line.

`toolchain.json` defines two supported TypeScript install layouts:

- `direct` installs TypeScript 7 as `typescript` for compiler-API consumers
  and declaration generation. Prefer this when every framework supports
  TypeScript 7.
- `split-compatibility` keeps TypeScript 6 as `typescript` for incompatible
  compiler-API consumers, then installs TypeScript 7 as `@typescript/native`
  for tools that explicitly require that compiler.

TypeScript 6 is compatibility-only. Use the split layout only for a command
that loads one of the peer blockers listed in `toolchain.json`, or for code
that imports the TypeScript compiler API. Remove the compatibility install when
the blocker accepts TypeScript 7. The shared config's peer range accepts both
layouts. Both layouts use `bun check` with Bun 1.4.3 for typechecking; retain
TypeScript wherever a tool needs its compiler API or declaration generation.
`stll-typecheck-parity` runs from a consumer repository root. It uses that repo's
TypeScript compiler (including the declared split layout), compares repository
diagnostics by file, line, and code, then checks 31 shipped fixture classes under
the consumer tsconfig flags. TypeScript diagnostics determine each class's
activation; inactive classes are identified in the table, and zero active classes
fail the check. The command fails on diagnostic differences or lost seeded coverage and reports wall
time and peak RSS for TypeScript and Bun. It requires Bun and `/usr/bin/time`
on Linux or macOS, and runs with Node or Bun. Tooling invokes the same bin through
`bun run check:typecheck-parity`. The bin invokes
`bun check` with its dedicated project/build flags. Consumer repositories must
not define a `check` script: it shadows Bun's checker, so the parity bin fails
with a clear error until that script is renamed. Standalone `bun --check`
checks the current project but does not forward these checker options.
Repositories with project references use build mode on both sides. Referenced
configs are discovered recursively and grouped by effective compiler options.
Each group copies its representative config's effective options, removes emit-only
and build settings, and sets `noEmit` for the seeded projects. Type-checking options
and consumer type/module resolution are preserved. Each group must
activate at least one seeded class. The installed compiler and Bun runtime must match their selected toolchain policy versions.
Both compilers check the same temporary project graph. TypeScript declarations
and build metadata stay in that temporary tree; consumer files remain untouched.
The parity bin does not validate the consumer project graph; the repository's own typecheck does.
Source errors normalize TypeScript's diagnostic exit `2` (including declaration-only inputs) to Bun's
diagnostic exit `1`; the report retains both raw exit codes. Other exit statuses
compare exactly. Comparisons retain source diagnostic locations, normalize bundled standard-library
paths, and distinguish locationless messages. Fixtures preserve the consumer package
module context and reject configuration errors. Tagged agent diagnostics are normalized
into the same comparison set.

Use the library TypeScript preset:

```json
{
  "extends": "@stll/typescript-config/library.json",
  "include": ["src"]
}
```

Use the oxlint preset with local exceptions:

```ts
import { library } from "@stll/oxlint-config";

export default library({
  ignorePatterns: ["dist/", "npm/", "*.node"],
  overrides: [
    {
      files: ["scripts/**"],
      rules: {
        "no-console": "off",
      },
    },
  ],
});
```

Add the portable safety rules to an existing Oxlint config:

```ts
import { defineConfig } from "oxlint";
import {
  portableSafetyPluginSpecifiers,
  portableSafetyRules,
} from "@stll/oxlint-plugin";

export default defineConfig({
  jsPlugins: [...portableSafetyPluginSpecifiers],
  rules: { ...portableSafetyRules },
});
```

For TanStack Router + React Query applications, add the route-query guards to
prevent cache misses and render-fetch waterfalls during navigation:

```ts
import { defineConfig } from "oxlint";
import {
  routeQueryPluginSpecifiers,
  routeQueryRules,
} from "@stll/oxlint-plugin";

export default defineConfig({
  jsPlugins: routeQueryPluginSpecifiers,
  rules: routeQueryRules,
});
```

`require-loader-prefetch` requires every statically attributable
`useSuspenseQuery` in a route to be referenced by that route's `loader`.
`no-raw-route-query-client` requires route freshness helpers instead of raw
TanStack Query client calls and keeps pending components synchronous.

When using `no-unsafe-inner-html`, disable the blanket `react/no-danger` rule;
the portable rule permits static and provably sanitized HTML while rejecting
untrusted values.

Oxlint 1.80 replaced `react/react-compiler` with category-specific React
Compiler rules. The actionable categories are part of the default rule set;
`react/invariant` and `react/todo` remain off because they report compiler
internals rather than source defects. Consumers can suppress one precise
category without hiding unrelated compiler diagnostics. A repo adopting these
rules against an existing findings backlog should carve out temporary
`overrides` entries per legacy path and fix forward.

Use the helper directly as the root config when possible. That keeps root-level
options, shared JS plugins, shared ignores, and local exceptions in one merged
object.

If a repo needs the `extends` style used by other oxlint config packages, keep
repo-specific ignores in the root config:

```ts
import stella from "@stll/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [stella],
  ignorePatterns: ["dist/", "npm/", "*.node"],
});
```

CommonJS repos can use `require` in `oxlint.config.ts`:

```ts
const { library } = require("@stll/oxlint-config");

module.exports = library();
```

Recommended scripts:

```json
{
  "scripts": {
    "typecheck": "bun check",
    "lint": "bun --bun oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error --deny-warnings --type-aware .",
    "lint:fix": "bun --bun oxlint -c oxlint.config.ts --type-aware --fix ."
  }
}
```

Use the Rust templates by copying them into a Rust repository:

```bash
cp rust/rustfmt.toml /path/to/repo/rustfmt.toml
cp rust/clippy.toml /path/to/repo/clippy.toml
cp rust/dylint.toml /path/to/repo/dylint.toml
```

Then copy either `rust/cargo-root.toml` or `rust/cargo-workspace.toml` into the
repository's root `Cargo.toml`. Cargo does not support extending these settings
from another package, so the templates are kept here as the canonical source and
synced into consumers.

Pin the `rev` in `dylint.toml` to the exact tooling commit being adopted. Then
run Clippy first and Dylint second:

```bash
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo dylint --workspace --all -- --all-targets --all-features -- -D warnings
```

## Releasing packages

Add a Changeset for every pull request that changes a published package. Choose
the affected package and semantic bump with `bun run changeset`; use an empty
Changeset when a release is intentionally unnecessary.

After the change lands on `main`, the shared release workflow maintains one
Version Packages pull request. Merging that pull request updates package
versions and changelogs, then `.github/workflows/publish.yml` builds the
tarballs and delegates the hardened npm and GitHub release transaction to the
versioned `stella/.github` contract. Package tags use the immutable
`<name>@<version>` form.
