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
Runtime images may retain a full SHA256 digest alongside an exact stable patch
tag: Node must be inside its policy series and match tracked root `.node-version`
when present; Python must be a patch in its policy series; Bun must equal its
policy version. Supported image variants remain allowed. Static image families
outside Node, Python, and Bun are outside this runtime check; unresolved image
names still fail.
Digest validation is declaration-only: the guard enforces the exact policy tag
and a full SHA256 digest, but does not verify that the digest belongs to the tag.
Dependabot refreshes digests per repository; a shared tag-to-digest map would
require a tooling release for every base-image digest bump across repositories,
which costs more than it buys.
GitHub JavaScript action host runtimes (`runs.using`) are platform-managed
and do not select the project toolchain Node version.

A published package can test the minimum Node major in its `engines.node`
support range in one declared workflow job. Add a scoped `engineFloors` entry
to tracked root `stll-toolchain.json`:

```json
{
  "engineFloors": [
    {
      "package": "packages/library",
      "workflow": ".github/workflows/ci.yml",
      "job": "node-floor"
    }
  ]
}
```

That job may use a literal exact stable patch in setup-node's `node-version`
whose major matches the range's minimum major and whose release satisfies
the range (for example, `20.10.0` for `>=20.10.0`). The approved action SHA, version comment and input validation
also apply. Other jobs and runtime files follow the shared Node series.
Missing packages or jobs, private packages, absent setup-node selectors and
floor mismatches fail configuration validation. `optOuts` is optional when
only `engineFloors` is declared.

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
The package guide is the canonical contract for
[checkout provenance, runtime version files and scoped `dynamicSelectors`](packages/oxlint-config/README.md).
It documents current-source and delegated refs, reusable-workflow caller context,
sparse-checkout requirements, declaration locators and fail-closed validation.
Use scoped declarations for reviewed unresolved selectors rather than broader
rule opt-outs; literal pins and local-action provenance remain enforced.

The named rules are `bun-pins`, `package-pins`, `typescript-layout`,
`node-engine`, `node-version`, `python-version`, `rust-version`,
`runtime-manager`, `runtime-docker`, `runtime-workflow`, `action-pins`,
`dependabot-policy`, and `cloud-setup-drift`. An exception requires a tracked root
`stll-toolchain.json` listing the rule and its reason:

```json
{
  "optOuts": [{ "rule": "bun-pins", "reason": "This repository uses npm." }]
}
```

Workspace TypeScript toolchains combine the root and declared members' devDependencies.
An included member may declare the exact TypeScript 6 compatibility API across
dependencies, devDependencies, and peerDependencies when that shared install uses
the complete split layout. Ambiguous or partial layouts do not grant this allowance.
Peer ranges declare support: they must include the policy compiler release and the
compatibility release when the selected layout uses it. Ranges do not contribute
to the installed compiler inventory.

JavaScript update roots come from the repository root, declared workspace membership,
and directories with their own `bun.lock`, `package-lock.json`, `yarn.lock`, or
`pnpm-lock.yaml`. Other package manifests do not create update roots; directory names
have no special meaning. Workspace members share their owner's update entry.

`node-engine` and `cloud-setup-drift` are mandatory: opt-outs cannot bypass the
shared Node support range or generated cloud setup requirements.

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

The shared defaults require TypeScript 7.0.2 or newer, oxlint 1.87.0 or
newer, and oxlint-tsgolint 7.0.2003 or newer. Pin the current versions from
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
Without flags, the command checks the root `tsconfig.json` and uses build mode
for project references. To check selected configs, repeat `--project`, for example
`stll-typecheck-parity --project packages/api/tsconfig.json --project packages/web/tsconfig.json`.
Selected configs run independently without discovering or building their references;
reference metadata is retained for ordinary project checks. No root tsconfig is
required in this mode, and the compiler always comes from the repository-root
installation. Missing, unreadable, and zero-input selected configs fail the check.
`--help` prints usage and exits successfully. In default mode, referenced
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
import { defineConfig } from "oxlint";

import stella from "@stll/oxlint-config";

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

## Shared cloud setup

Declare `cloud` in tracked root `stll-toolchain.json`, then run
`bunx --no-install stll-cloud-setup` to generate `.agents/cloud-setup.sh`.
The declaration requires `install` exactly `bun install --frozen-lockfile`.
`services` is any subset of `postgres` and `valkey`; omit it or use `[]` for
runtimes and dependencies only. A canonical repository-relative `envFile`, such
as `.env.cloud`, is required with services and rejected without services.
Runtime-only scripts emit no environment file code. A tracked root
`.node-version` must select an exact stable patch within the shared Node series.
The mandatory `cloud-setup-drift` rule compares the committed script with the
same generator and rejects missing, changed, or undeclared scripts.

The script has explicit `install` and `start` commands. It targets Ubuntu 24.04
with root access or passwordless sudo; these are capability requirements,
not assumptions about every cloud image. See the
[package guide](packages/oxlint-config/README.md#shared-cloud-setup) for lifecycle
wiring, service isolation, environment-file ownership, and host documentation.

## Published package contracts

Run `stll-publish-contract` in PR CI. Every published root or declared workspace
package commits `publish-contract.json`, recording engines, peer support ranges,
resolved JavaScript targets, and entry points. `stll-publish-contract --write`
records an explicit contract decision as a reviewable diff; it also validates
consumer support and cannot accept development-only requirements.

The consumer policy pins Node 22.23.3, npm 12.2.0, pnpm 12.9.1, and TypeScript
6.0.3 independently of the development toolchain. Published engines and TypeScript
peers must support the consumer versions; ranges may include newer versions.
An absent `engines.node` is unrestricted, matching package-manager semantics; a
declared range must contain the consumer Node version. Both guards share this rule.
Bun runtime/compiler requirements are rejected. JSON and declaration-only packages
record `{"type":"types-only"}` explicitly.

Build adapters use the installed configuration loaders and bind their behavior to
tsdown 0.22.9, Vite 8.1.5, or @nuxt/module-builder 1.0.3 (unbuild 3.6.1 and
mkdist 2.4.1). They record final transform targets, including separate Nuxt module
and runtime entries. No syntax lowering records `esnext`.
Only exact single build invocations (`tsdown`, `vite build`, or
`nuxt-module-build build`) are supported. Shell composition, environment prefixes,
launchers, directory changes, workspace filters, and CLI overrides fail.
Vite accepts its version-bound default plugin pipeline and the default
`@vitejs/plugin-vue` 6.0.8 factory; custom Vue compiler, template, script, and feature
options are unsupported. Nuxt accepts the version-bound builder and owned target
hook. Unapproved plugins, output transforms, and execution-order changes fail. The static guard validates the supported configuration, without parsing the
emitted JavaScript syntax. Add a reviewed adapter when adopting another build tool.

Nuxt modules can set both emitted targets without replacing the builder's entries:

```ts
import { nuxtModuleTarget } from "@stll/oxlint-config/build-target";

export default { hooks: { "build:before": nuxtModuleTarget("es2022") } };
```

The Nuxt adapter accepts this owned hook from the same package version as the CLI;
it captures the normalized configuration before cleanup or output writes. The built
publish-contract CLI is also checked against a TypeScript configuration and relative
TypeScript import on the package's minimum supported Node release.

The static guard models `publishConfig` overrides for `exports`, `main`, `module`,
`types`, `typings`, `bin`, and `typesVersions`; `access` and `registry` are allowed
publication metadata. Other overrides, including `engines`, are rejected. A real
pnpm-pack test compares every modeled contract field with the tarball manifest.

Packed-artifact checks run nightly, while the static contract check runs per PR.
The reusable consumer job declares its exact scope in `stll-toolchain.json`:

```json
{
  "consumerChecks": [
    {
      "workflow": ".github/workflows/consumer-compat.yml",
      "job": "consumer",
      "packages": ["packages/library"],
      "toolingVersion": "<installed tooling version>",
      "fixturePath": "tests/consumer"
    }
  ]
}
```

The declared workflow requires valid five-field cron with bounded numeric values,
month/day names, lists, ranges, and positive steps; manual dispatch is optional.
Day of week is 0–6 (SUN–SAT), matching the [GitHub Actions schedule contract](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule); numeric 7 is unsupported. The combined schedules must cover every weekday with unrestricted month and date fields, so weekly or seasonal schedules cannot satisfy the daily contract. Public packages require a semver-valid version. Published workspace packages under a `vendor` directory are unsupported; the contract CLI reports them rather than omitting them. `bundleDependencies` and `bundledDependencies` are unsupported because artifact staging does not install a bundled dependency tree; remove these fields before declaring consumer checks.
The reusable consumer job must be stand-alone and unconditional (no `needs`, `if`, or `strategy`), so a job condition
cannot skip its scheduled execution.
That job calls `package-consumer-compat.yml` at the approved shared policy SHA with
`packages` as the same JSON array and `consumer-node` equal to the consumer policy
pin. Required `tooling-version` and `fixture-path` inputs equal the declared exact
`toolingVersion` and repository-relative `fixturePath`; its `consumer-compat.json` must
be tracked, parse with the runner’s fixture schema, and select exactly the declared package set. Replace `<installed tooling version>` with the exact installed
`@stll/oxlint-config` release that provides the consumer runner; the guard binds the
declaration to that package version. Every named package and its transitive workspace closure must be tracked,
published, and have valid manifests. Each selected package must support that Node version.
Unknown jobs, stale entries, undeclared consumer calls, and inconsistent inputs fail.
This declaration applies to consumer checks; `engineFloors` retains its separate
minimum-supported-major contract.

`stll-consumer-compat --packages '["packages/library"]' --consumer-node 22.23.3
--fixture-path tests/consumer` tests final tarballs in isolated projects with both
npm and pnpm. The repository builds once with its development toolchain first.
The runner reads the exact packer version and pack flags from a single tracked
release workflow and packs directly with that manager. Missing, ambiguous, or
unsupported pack configuration fails. Both consumers install the same release
artifacts; the runner does not rewrite workspace or catalog protocols through a
different manager. Fixture installs disable scripts, reject reserved runtime/manager bins throughout nested lifecycle paths, then approve only directly declared dependencies at their resolved lock identities. npm rebuilds those identities; pnpm runs its built-in pending rebuild. Both use the pinned consumer runtime before typecheck, build and smoke. Undeclared transitive build scripts receive no approval. Catalog entries that resolve to a local workspace
package are unsupported: use `workspace:` for that dependency. Registry catalog declarations are staged intact; the release packer must resolve
publication protocols. pnpm workspace owners require an adjacent tracked
`package.json`; manifestless owners are unsupported. Public package names must be
canonical lowercase, URL-safe npm names (at most 214 characters), with no traversal components. Workspace alias
specifiers are unsupported: use the package name as the dependency key. The runner verifies
the official Node archive checksum and exact runtime/package-manager versions,
uses the oldest published React satisfying the package peer range and, when ReactDOM is required, its compatible renderer peer range, typechecks with
the consumer TypeScript, and runs each fixture's build and usage smoke. Both
publication packers and fixture commands use the provisioned consumer Node with
isolated package-manager settings. Consumer command PATH contains only pinned wrappers, fixture binaries, and `/usr/bin:/bin`; it never inherits development tool directories. Installed binaries named `node`, `npm`, `npx`, or
`pnpm` are rejected before fixture build and smoke commands.

The fixture directory contains `consumer-compat.json`:

```json
{
  "packages": [
    {
      "package": "packages/library",
      "fixture": "library",
      "kind": "node",
      "build": ["npm", "run", "build"],
      "smoke": ["npm", "run", "smoke"]
    }
  ]
}
```

The selected package set must exactly match the fixture declaration set.
Each fixture is a standalone project with its own source, package manifest, and
TypeScript configuration. The package peers determine its fixture kind: a React
peer requires `react` and a render smoke; other packages require `node` and an
import with a representative call. A mismatching declaration fails. Dependency bindings, runtime tools,
and caches belong to the runner. A nightly failure must open or update one issue
in the consuming repository and use its existing failure notification.
