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

## Shared toolchain

`@stll/oxlint-config/toolchain.json` is the versioned source for shared tool
versions. Install `@stll/oxlint-config` as a dev dependency, inherit its pins,
and run `bunx --no-install stll-toolchain-check` from the repository root in CI.
The CLI inspects tracked configuration files, prints `path:line: [rule] message`,
and exits with status 1 on a mismatch. Tools absent from a repository do not
introduce requirements.

Schema version 1 contains these fields:

| Fields                                                                                     | Contract                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                                                                            | Supported policy schema version (`1`).                                                                                                                                                                                                                                                                                                                                                                                  |
| `bun`                                                                                      | Exact `packageManager`, `bun-types`, image and manager pin.                                                                                                                                                                                                                                                                                                                                                             |
| `oxlint`, `oxlint-tsgolint`, `@oxlint/plugins`, `@stll/oxlint-plugin`, `oxfmt`, `lefthook` | Exact dependency and catalog pins. Declared local workspace packages must resolve to the same version.                                                                                                                                                                                                                                                                                                                  |
| `typescript`, `typescriptInstallLayouts`, `typescript6Compatibility`                       | Exact compiler pins and complete direct or split install layouts; the optional compatibility alias is exact too.                                                                                                                                                                                                                                                                                                        |
| `node`, `python`, `rust`, `rustCompilerDevelopment`                                        | Runtime selectors and version-manager pins. Node selects the policy major (`26.x`); static minor and patch selectors within that major are allowed. A Python minor pin preserves existing patch selectors within that release series; a patch policy requires the exact patch. Rust selects the stable release unless a toolchain file declares the `rustc-dev` component; compiler development uses its dated nightly. |
| `actions`                                                                                  | Approved action names mapped to full `sha` and `version` comment.                                                                                                                                                                                                                                                                                                                                                       |
| `dependabot`                                                                               | Shared schedule, cooldown and groups. Package and action ignores derive from the owned pins.                                                                                                                                                                                                                                                                                                                            |

Configure `oven-sh/setup-bun` with `bun-version-file: package.json` and a
matching `packageManager`. Configure setup-node/setup-python with
`node-version-file`/`python-version-file` referencing tracked `.node-version`
or `.nvmrc` / `.python-version` files; direct version inputs are forbidden.
Node and Python image tags and mise/asdf entries inherit the same pins.
The Node policy is `26.x`: selectors must select major 26. Bare major,
major wildcard, minor and stable patch selectors within that major are allowed;
open ranges, other majors, prereleases and floating aliases fail.
Release and publish workflows use exact patch version-file selectors for
reproducible builds; this repository pins `.node-version` to `26.10.0`.
The series policy accepts that patch without weakening release validation.
GitHub JavaScript action host runtimes (`runs.using`) are platform-managed
and do not select the project toolchain Node version.

The Rust stable pin is `1.96.0`; `rustCompilerDevelopment` is
`nightly-2026-04-16`. Only a `rustc-dev` component declaration selects that
nightly. A nightly without that component fails.

`engines.node` and `requires-python` are support ranges: they must include the
shared runtime. The Node support range must include every stable release in
the policy major, so `>=26`, `^26` and `^24 || ^26` pass; `^24`, `<26`,
`>=27` and ranges that omit part of major 26 fail. A minor Python pin requires support for every patch in that
series. Python comparisons, compatible releases, wildcard exclusions,
and comma intersections are supported for final releases; unsupported syntax
produces a diagnostic.

Direct compiler invocations in `scripts.typecheck` must use the selected
layout command. Classification decodes shell tokens to find compiler calls;
acceptance requires the declared command text after leading environment
prefixes are removed, including its option spelling and quoting. Delegated wrappers and workspace runners are checked by the
consumer typecheck parity contract rather than inferred from manifests.

Listed shared actions require their approved SHA and matching `# vX` comment.
CI also checks the shared release policy's runtime selector action set against
`toolchain.json`, deriving its immutable checkout ref from the existing
release-policy workflow reference.
Other remote actions and reusable workflows require a full SHA. Local actions
are repository-owned. The checker resolves YAML aliases and TOML tool tables.
A runtime version file may come from a preceding checkout in the same job:
use the exact `${{ job.workflow_repository }}` / `${{ job.workflow_sha }}` pair,
or a same-repository checkout with no `ref`. For no-ref checkouts, omit
`repository`, name this repository literally, or use `${{ github.repository }}`.
The checkout must omit both `if` and `continue-on-error`, and its normalized
path must be unique among every checkout in that job, including later steps.
Unknown checkout destinations prevent mapped selectors from proving provenance.
Sparse checkouts must explicitly list the selected repository-relative file,
without the checkout prefix, in `sparse-checkout`. This applies in either cone
mode and to delegated sources. Dynamic, empty, glob, negation, or unsupported
sparse configurations fail; a cone-mode input alone is insufficient. Directory
entries cannot substitute for the selected file.
Other nonempty, nonconstant GitHub expression refs on same-repository checkouts
(including `${{ job.workflow_repository }}`) delegate a safe static version-file selector
to that checkout. The CLI reports delegation on stdout without validating the
current source's version file. Literal refs and unpaired `${{ github.sha }}` /
`${{ job.workflow_sha }}` remain rejected.
For snapshot-bound sources, the guard maps a prefixed selector to the
corresponding tracked source file.
Literal commit SHAs, branches, tags, unpaired snapshot contexts,
foreign repositories, and traversal paths cannot supply mapped runtime files.

The named rules are `bun-pins`, `package-pins`, `typescript-layout`,
`node-engine`, `node-version`, `python-version`, `rust-version`,
`runtime-manager`, `runtime-docker`, `runtime-workflow`, `action-pins`, and
`dependabot-policy`. An exception requires a tracked root
`stll-toolchain.json` listing the rule and its reason:

```json
{
  "optOuts": [{ "rule": "bun-pins", "reason": "This repository uses npm." }]
}
```

`node-engine` is mandatory: an opt-out cannot bypass the shared Node support range.

Unknown rules, empty reasons, duplicate rules, and malformed configurations
fail. Opt-outs apply repository-wide to the named rule, so keep them narrow.

`.github/dependabot.yml` is the shared reference. It declares each detected
package ecosystem and update root (Bun roots use `bun`, npm/pnpm/Yarn use
`npm`, and uv projects use `uv`), uses the policy schedule/groups and a
five-day cooldown, and ignores tooling-owned npm and action pins. Workspace
members share their update root; independent manifests need their own entry.
`pnpm-workspace.yaml` owns pnpm catalogs and membership. Omitted `packages`
includes only the root, matching the current pnpm contract; declare member
patterns explicitly to keep membership stable across pnpm versions.
The generator derives the reference from the same policy and ecosystem
registry as the guard: run `bun scripts/write-dependabot-policy.ts` after
policy changes. Consumers can copy its applicable entries and directory paths;
the CLI rejects missing coverage and policy drift. Owned package pins follow
release metadata. The `changeset:version` command first includes the policy
package in the release plan whenever an owned workspace pin changes, then
synchronizes pins through `bun scripts/check-lockfile-workspace-versions.ts
--write`, which also refreshes cached workspace versions without regenerating
the dependency graph.

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
