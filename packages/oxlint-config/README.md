# @stll/oxlint-config

Shared oxlint presets, JavaScript plugins, and toolchain policy for Stella
packages. Repository-specific rules and exceptions belong in the consuming
repository's configuration.

## Install and configure

```sh
bun add -d @stll/oxlint-config
```

Install `oxlint`, `oxlint-tsgolint`, and any other shared tools at the exact
versions in the exported `@stll/oxlint-config/toolchain.json`. That file is the
source for current pins; peer dependency ranges describe supported versions.

Use the library preset in `oxlint.config.ts`:

```ts
import { library } from "@stll/oxlint-config";

export default library({
  ignorePatterns: ["dist/"],
  overrides: [
    {
      files: ["scripts/**"],
      rules: { "no-console": "off" },
    },
  ],
});
```

The preset includes the shared `stella-lowercase` and `no-raw-colors`
JavaScript plugins. The separate `@stll/oxlint-plugin` package provides
portable safety and route-query rules. See the
[repository usage guide](https://github.com/stella/tooling#usage) for other
presets, CommonJS configuration, and plugin composition.

## Shared toolchain and Bun

`@stll/oxlint-config/toolchain.json` is a versioned policy for package pins,
Bun, TypeScript install layouts, Node, Python, Rust, GitHub Actions, and
Dependabot. Inherit the fields for tools your repository uses. The checker
does not require tools absent from the repository.

Set `packageManager` to `bun@` followed by the policy's `bun` value, and pin
`bun-types` to that same value. Dependency pins can live in default or named
catalogs, including Bun's `workspaces` catalogs. Bun image tags, version
files, and mise/asdf entries also inherit the policy pin.

Configure `oven-sh/setup-bun` with a tracked manifest as its version source:

```yaml
with:
  bun-version-file: package.json
```

The action itself must use the policy's approved SHA and version comment.
A prefixed version-file selector can use a preceding checkout in its job:
use the exact `${{ job.workflow_repository }}` / `${{ job.workflow_sha }}` pair,
or a same-repository checkout with no `ref`. For no-ref checkouts, omit
`repository`, name this repository literally, or use `${{ github.repository }}`.
The checkout must omit both `if` and `continue-on-error`, and its normalized
path must be unique among every checkout in that job, including later steps.
Unknown checkout destinations prevent mapped selectors from proving provenance.
Sparse checkouts must explicitly list the selected repository-relative file,
without the checkout prefix, in `sparse-checkout`; a root-anchored entry such as
`/package.json` is accepted. This applies in either cone mode and to delegated
sources. Empty, glob, negation, or unsupported sparse configurations fail; a
cone-mode input alone is insufficient. Directory entries cannot substitute for
the selected file. A scoped Bun-source declaration can acknowledge a dynamic
sparse expression, but cannot waive a literal omission or invalid pattern,
including literal patterns mixed with expression lines or literal fragments
adjoining an expression. The deepest checkout destination containing a static selected file supplies that
file. Sparse validation checks that provider, including every writer at the same
destination, before expression acknowledgement; ancestor sparse settings do not
constrain an independent nested checkout. Checkout writes are processed in step
order: any later ancestor checkout invalidates earlier descendants, regardless of
its clean input. Checkout may clear a destination without a matching Git repository
even when clean is false. Unresolved clean values remain untrusted. Unknown
selectors remain fail closed. Mixed literal/expression sparse
configurations retain their literal paths: those paths must explicitly include a
static selected manifest. A declaration acknowledges only expression additions;
For every static manifest selector from the inspected source, the manifest pin
is validated after sparse acknowledgement, including fully dynamic sparse inputs.
Other nonempty, nonconstant GitHub expression refs on same-repository checkouts
(including `${{ job.workflow_repository }}`) delegate a safe static version-file selector
to that checkout. The CLI reports delegation on stdout without validating the
current source's version file. Current-source checkouts also accept
`${{ github.sha }}` on the same repository, except reusable `workflow_call`
workflows whose GitHub context belongs to the caller. Reusable workflows must
use the exact workflow repository/SHA pair to authorize local actions. A default
reusable-workflow checkout delegates the caller manifest just like an explicit
caller repository/SHA binding. This default applies only when the repository is
omitted or exactly `${{ github.repository }}`; a literal workflow-repository
checkout without a ref does not identify the caller snapshot. Mutable `${{ github.ref }}` bindings delegate
on every event; only the event SHA establishes the inspected snapshot. PR-head
SHA/ref expressions and their fallbacks are delegated: they cannot establish
local-action provenance or validate the inspected source's manifest. Local
actions require current-source bindings. Literal refs, foreign repositories and
unpaired `${{ job.workflow_sha }}` remain rejected.
For snapshot-bound sources, the guard maps the selector to its tracked source
file. Literal commit SHAs,
branches, tags, unpaired snapshot contexts, foreign repositories, and traversal
paths fail.
Direct `bun-version` inputs are forbidden. For snapshot-bound sources, the
manifest referenced by `bun-version-file` must declare the shared
`packageManager` value. Delegated commits own their version validation.

The Node policy is `26.x`. Runtime selectors (`.node-version`, `.nvmrc`,
setup-node's `node-version-file`, Node image tags and mise/asdf entries)
must select major 26: bare major, major wildcard, minor and stable patch
selectors within that major are allowed. Open ranges, floating aliases,
other majors and prereleases fail. Use `node-version-file` for setup-node.
`engines.node` remains a support range and must include every stable release
in major 26; `>=26`, `^26` and `^24 || ^26` pass, while ranges that omit
part of major 26 fail.
Release and publish workflows use exact patch version-file selectors for
reproducible builds; this repository pins `.node-version` to `26.10.0`.
The series policy accepts that patch without weakening release validation.
Runtime images may retain a full SHA256 digest alongside an exact stable patch
tag: Node must be inside its policy series and match tracked root `.node-version`
when present; Python must be a patch in its policy series; Bun must equal its
policy version. Supported image variants remain allowed.
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

A runtime image or Bun source selected by an expression can have a scoped,
reviewed `dynamicSelectors` declaration instead of a whole-rule opt-out:

```json
{
  "dynamicSelectors": [
    {
      "path": ".github/workflows/example.yml",
      "at": "jobs.example.services.database",
      "kind": "image",
      "reason": "The scoped image producer validates the selected image."
    },
    {
      "path": ".github/workflows/example.yml",
      "at": "jobs.example.steps.setup",
      "kind": "bun-source",
      "reason": "The manifest producer selects the owned source snapshot."
    }
  ]
}
```

`at` identifies a job container (`jobs.<job>.container`), job service
(`jobs.<job>.services.<service>`), Compose image (`services.<service>.image`),
or setup step ID (`jobs.<job>.steps.<id>`; `runs.steps.<id>` in a composite
action). If a step has no ID, replace `at` with a positive `line` number
pointing at its version-file selector. Images without an ID locator (including
unresolved Dockerfile `FROM` arguments) can also use a line number. Prefer IDs so unrelated edits do not
move the declaration. Each declaration requires an exact tracked path, one
locator, a known kind and a nonempty reason. It must match exactly one unresolved
selector; missing, static or ambiguous locations fail configuration validation.
An image declaration applies only to an expression, never a literal runtime pin.
A Bun declaration acknowledges an unresolved manifest expression or same-source
dynamic checkout ambiguity; it does not verify the selected version. Foreign or
literal-ref checkouts, incorrect action pins and conditional/error-tolerant
checkouts still fail. Local-action provenance is independent of these declarations.
Review the producer named in the reason whenever the selector changes.

Run the installed checker from the repository root in CI:

```sh
bunx --no-install stll-toolchain-check
```

The CLI checks tracked files, prints `path:line: [rule] message` diagnostics,
and exits with status 1 on a mismatch. Updating the package updates the
policy; update consumer pins and run the checker together.

`typescriptInstallLayouts` declares the compiler package, exact specifier,
and typecheck command for each supported layout. Prefer the direct layout.
Use the split compatibility layout for the compiler-API consumers and peer
blockers listed in `typescript6Compatibility`; it retains the current
compiler for typechecking while providing the compatibility package.

An exception requires a tracked root `stll-toolchain.json` with the named
rule and a nonempty reason:

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

Opt-outs apply to the entire repository for that rule. Unknown or duplicate
rules, empty reasons, and malformed configuration fail validation. See the
[shared toolchain reference](https://github.com/stella/tooling#shared-toolchain)
for the schema, rule list, runtime support ranges, and generated Dependabot
template.

## Typecheck parity project selection

Run `stll-typecheck-parity` from the repository root. Without flags, it checks
the root `tsconfig.json` and recursively discovers project references in build
mode. Repeat `--project` to check exactly the selected configs:

```sh
stll-typecheck-parity --project packages/api/tsconfig.json --project packages/web/tsconfig.json
```

Selected configs run independently using the repository-root compiler
installation; child packages need no compiler declaration and a root tsconfig
is unnecessary. Their original reference metadata is preserved without
discovering or building referenced projects. Missing, unreadable, and zero-input
selected configs fail the check. `--help` prints usage and exits successfully;
unknown arguments fail.

## Shared cloud setup

Add an explicit declaration to tracked root `stll-toolchain.json`:

```json
{
  "optOuts": [],
  "cloud": {
    "services": ["postgres", "valkey"],
    "install": "bun install --frozen-lockfile",
    "envFile": ".env.cloud"
  }
}
```

Services are optional: omit `services` or use `[]` for runtimes and dependencies
only. No `cloud` declaration means no cloud setup script. `envFile` is required
with services and rejected without services; runtime-only scripts emit no
environment file code. With services, `envFile` must be a canonical
repository-relative path; its existing parent must be safe at runtime. Track an exact stable Node patch in root
`.node-version` within the shared Node series. Generate and commit the script:

```sh
bunx --no-install stll-cloud-setup
```

Generation uses the installed policy's Bun, Node, PostgreSQL, and Valkey pins.
PostgreSQL uses the PGDG major-version packages; minor updates within the pinned
major are accepted for the disposable database. Before adding PGDG, provisioning
reuses an existing source only after verifying its signing-key fingerprint;
conflicts identify the source file. Existing matching-major binaries are reused. Valkey uses official versioned
binary DEBs for the declared release and architecture, verifies the policy's
SHA256 pins, and installs those local files with apt. It does not resolve Valkey
from a mutable package index.
The command writes `.agents/cloud-setup.sh` with executable permissions and
refuses symlink parents or destinations and hard-linked destinations. `stll-toolchain-check` rejects missing,
drifted, or undeclared tracked scripts with mandatory `cloud-setup-drift`.
Regenerate after changing the policy or declaration. `stll-cloud-setup --help`
prints usage without reading repository configuration.

| Environment phase       | Command                               |
| ----------------------- | ------------------------------------- |
| Networked install       | `bash .agents/cloud-setup.sh install` |
| Offline session startup | `bash .agents/cloud-setup.sh start`   |

Both commands can be rerun. Missing or unknown subcommands print usage and
exit 2; there is no implicit lifecycle mode. The script supports Ubuntu 24.04
with root access or passwordless sudo and fails when required capabilities
or pinned installations are unavailable. `install` provisions runtimes,
dependencies, and declared services; `start` restores local services after
cached environments lose running processes. Services bind only to localhost.
System provisioning runs as root; frozen dependencies run as the invoking user
with that user's home and a private, user-owned Bun cache. Package installation
does not permit automatic downgrades.
If a newer Valkey package is already installed, provisioning fails rather than
downgrading it; use an environment compatible with the pinned release.
The environment file contains `NODE_ENV=test` and declared local connection
URLs, carries a generated ownership marker, and refuses an unowned file or
symlink. Configure the repository's test runner to load that file; migration
commands and repository adoption are separate configuration steps.

Environments may cache filesystems without preserving service processes.
Run `start` at every session start, including sessions that reuse installed files.
The supported OS, privileges, and pinned runtime requirements are checked explicitly.

## Published package contracts

Run `stll-publish-contract` in PR CI. Every published root or declared workspace
package commits `publish-contract.json`, recording engines, peer support ranges,
resolved JavaScript targets, and entry points. `stll-publish-contract --write`
records an explicit contract decision as a reviewable diff; it also validates
consumer support and cannot accept development-only requirements.

The consumer policy pins Node 22.23.3, npm 12.2.0, pnpm 12.9.1, and TypeScript
6.0.3 independently of the development toolchain. Published engines and TypeScript
peers must support the consumer versions; ranges may include newer versions.
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

The reusable consumer job must be stand-alone and unconditional (no `needs`, `if`, or `strategy`), so a job condition
cannot skip its scheduled execution.
The declared workflow requires a nonempty `on.schedule` with validated five-field cron (field bounds, lists, ranges, and positive steps);
Day of week is 0–6 (SUN–SAT), matching the [GitHub Actions schedule contract](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule); numeric 7 is unsupported.
`workflow_dispatch` may also be enabled. That job calls the shared
`package-consumer-compat.yml` workflow at its approved immutable policy pin, with
`packages` as the same JSON array and `consumer-node` equal to the consumer policy
pin. Required `tooling-version` and `fixture-path` inputs equal the declared exact
`toolingVersion` and repository-relative `fixturePath`; its `consumer-compat.json` must
be tracked. Replace `<installed tooling version>` with the exact installed
`@stll/oxlint-config` release that provides the consumer runner; the guard binds the
declaration to that package version. Every named package must be tracked, published, and support that Node version.
Unknown jobs, stale entries, undeclared consumer calls, and inconsistent inputs fail.
This declaration applies to consumer checks; `engineFloors` retains its separate
minimum-supported-major contract.

`stll-consumer-compat --packages '["packages/library"]' --consumer-node 22.23.3
--fixture-path tests/consumer` tests final tarballs in isolated projects with both
npm and pnpm. The repository builds once with its development toolchain first.
Workspace protocols are resolved by the package manager before `npm pack` creates
the final artifact; both consumers install those artifacts. Catalog entries that resolve to a local workspace
package are unsupported: use `workspace:` for that dependency. Registry catalog
dependencies remain supported. The runner verifies
the official Node archive checksum and exact runtime/package-manager versions,
uses the oldest published React satisfying the package peer range, typechecks with
the consumer TypeScript, and runs each fixture's build and usage smoke.

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

Each fixture is a standalone project with its own source, package manifest, and
TypeScript configuration. Use `react` for a React peer and a render smoke; use
`node` for an import and representative call. Dependency bindings, runtime tools,
and caches belong to the runner. A nightly failure must open or update one issue
in the consuming repository and use its existing failure notification.
