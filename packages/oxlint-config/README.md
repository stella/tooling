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

`library()` is framework-neutral. Enable React and its actionable React Compiler
rules only for files owned by React:

```ts
export default library({
  react: {
    files: ["packages/react/**/*.{ts,tsx}", "apps/web/src/**/*.{ts,tsx}"],
  },
});
```

Include `.ts` hooks as well as `.tsx` components. Keep Vue composables and other
frameworks outside these globs. Consumer `rules` take precedence over all preset
rules, including scoped presets. Consumer `overrides` are applied last and can
customize individual paths. React is activated only in the selected override.
Oxlint resolves later overrides against the base plugin list: when configuring
React rules in a consumer override, explicitly supply
`plugins: [...libraryPlugins, "react"]` (plus any other consumer plugins) and
select React-owned files. Framework-neutral
`jsx-a11y` configuration can continue to be supplied through `plugins` and `rules`.

When upgrading from a version that enabled React globally, add `react.files`
explicitly to preserve diagnostics in React packages. Direct composition is also
breaking: `libraryRules` and `libraryPlugins` are now framework-neutral. Import
`reactRules` and add `"react"` to the plugins of a file-scoped override to retain
React diagnostics.

## Shared toolchain and Bun

`@stll/oxlint-config/toolchain.json` is a versioned policy for package pins,
Bun, TypeScript install layouts, Node, Python, Rust, GitHub Actions, and
Dependabot. Inherit the fields for tools your repository uses. The checker
does not require tools absent from the repository.

Shared-pin Dependabot ignores must contain only `dependency-name` and
`update-types`, listing `version-update:semver-major`,
`version-update:semver-minor`, and `version-update:semver-patch`. This ignores
version updates while preserving security update pull requests.

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
static selected manifest. A declaration acknowledges only expression additions.
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

JavaScript update roots include the repository root, declared workspace membership,
and directories with their own `bun.lock`, `package-lock.json`, `yarn.lock`, or
`pnpm-lock.yaml`. Independent manifests with dependencies, an explicit package manager,
or dependency-bearing workspace members also create update roots. Metadata-only
fixtures do not. Package-manager selection follows the nearest declaration or lock;
workspace members share their owner's update entry. Bundler `Gemfile`/`Gemfile.lock`
and Composer `composer.json`/`composer.lock` declare roots at their own directories.

`node-engine`, `workflow-trust` and `cloud-setup-drift` are mandatory: opt-outs cannot bypass the
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

## Generate dependency update configuration

Run `bunx --no-install stll-dependabot` from the repository root. It reads tracked
configuration and writes canonical `.github/dependabot.yml`, preserving an existing
`.github/dependabot.yaml` spelling, including when the indexed output has been
deleted from the working tree. Conflicting indexed or existing spellings are
rejected, and unrelated unreadable inputs still stop generation. Repeated runs
produce identical bytes; linked output files and directories are rejected.

For programmatic generation, the package entry point exports
`generateDependabotConfig({ files, policy })` and `parseToolchainPolicy`:

```ts
import {
  generateDependabotConfig,
  parseToolchainPolicy,
} from "@stll/oxlint-config";
import sharedPolicy from "@stll/oxlint-config/toolchain.json";

const yaml = generateDependabotConfig({
  files: trackedConfiguration,
  policy: parseToolchainPolicy(sharedPolicy).dependabot,
});
```

`files` maps tracked repository-relative configuration paths to their text. Use the
CLI when a tracked snapshot is not already available; no source imports are needed.

## Shared cloud setup

Add an explicit declaration to tracked root `stll-toolchain.json`:

```json
{
  "optOuts": [],
  "cloud": {
    "services": ["postgres", "valkey"],
    "install": "bun install --frozen-lockfile",
    "envFile": ".env.cloud",
    "rust": {
      "components": ["clippy", "rustfmt"],
      "targets": ["wasm32-unknown-unknown"]
    },
    "tools": {
      "cargo-nextest": "0.9.148",
      "gitleaks": "8.30.1",
      "wasm-bindgen-cli": "0.2.126",
      "uv": "0.13.1",
      "time": "1.9"
    }
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

Rust is optional. A tracked root `rust-toolchain.toml` enables it automatically;
otherwise declare `cloud.rust` to enable it. `cloud.rust.toolchain`, when given,
must be an exact stable Rust patch. The root toolchain file supplies the pin when
present; without either pin, the installed shared policy supplies it. Conflicting
pins fail generation. The selected pin must match the shared policy or a recorded
`rustExceptions` pin. `components` and `targets` select additional rustup
components and compilation targets; the root toolchain file also contributes
its selections. A declared root profile must be `minimal`. Rust installation uses
the minimal profile and a pinned, checksum-verified rustup installer. Rust-enabled
setup also provisions Ubuntu's `build-essential` package for native compilation
and linking.

`cloud.rust.additionalToolchains` explicitly selects extra exact compiler releases.
Each must match the shared pin or a valid `rustExceptions` entry and differ from the
primary compiler. Extras are installed once with the minimal profile and verified
offline at session start. An exception alone authorizes a version; it does not
provision it. This setting installs neither Hawk nor extra compiler components.
Generated scripts contain no trailing whitespace and end with one newline.

`cloud.tools` is a closed object: the supported keys are `cargo-nextest`,
`wasm-bindgen-cli`, `gitleaks`, `uv`, and `time`. Each value must be an exact release supported by
the installed tooling package. Unknown tools and unsupported versions fail
generation. `cargo-nextest`, `wasm-bindgen-cli`, `gitleaks`, and `uv` use versioned upstream Linux binaries with committed
SHA256 pins for amd64 and arm64; setup does not build them with `cargo install`.
`time` installs GNU time (`/usr/bin/time`, needed for `/usr/bin/time -v`) from
Ubuntu's `time` package with bounded apt; its value is the upstream release
(`1.9` on Ubuntu 24.04). GNU time reports its version as `UNKNOWN`, so setup
verifies the binary's GNU identity and the installed package release. A present,
matching package is reused without network access.
`wasm-bindgen-cli` requires the matching `wasm-bindgen` crate version in tracked
root `Cargo.lock`. Regenerate after updating the lockfile or any tool pin.

`cloud.prepare` (optional) names one root `package.json` script and a time bound,
for example `{ "script": "generate:cloud", "seconds": 300 }`. The install phase
runs it once after dependencies, as the invoking user, with stdin closed. At the
bound (1 to 900 seconds) the script receives TERM and, 10 seconds later, KILL;
when it ends, anything still running in its process group is killed. Use it
for cheap derived sources that tasks need when `install` skips lifecycle scripts;
it gets no network allowance. Generation fails when the script is not in the
root `package.json`.

Generation uses the installed policy's Bun, Node, PostgreSQL, and Valkey pins.
PostgreSQL uses the PGDG major-version packages; minor updates within the pinned
major are accepted for the disposable database. Before adding PGDG, provisioning
reuses an existing source only after verifying its signing-key fingerprint;
conflicts identify the source file. Existing matching-major binaries are reused. Valkey uses official versioned
binary DEBs for the declared release and architecture, verifies the policy's
SHA256 pins, and installs those local files with apt. It does not resolve Valkey
from a mutable package index.
The command writes `.agents/cloud-setup.sh` with executable permissions and
merges a `SessionStart` hook into `.claude/settings.json`. The hook runs
`bash "$CLAUDE_PROJECT_DIR/.agents/cloud-setup.sh" start` only when
`CLAUDE_CODE_REMOTE=true`, including sessions that reuse cached filesystems and
sessions started from a repository subdirectory. Generation replaces the exact hooks written by 1.1.0 and 1.3.1 in place.
After successful startup, it appends the
managed shell profile's literal exports to `CLAUDE_ENV_FILE` when available, so
subsequent Claude commands select pinned runtimes and tools before preinstalled
versions while retaining their inherited `PATH`. The settings also set
`"attribution": {"commit": "", "pr": ""}`, so cloud sessions add no tool
attribution to commits or pull requests. Existing environment-file
content, unrelated settings, and hooks are preserved. Invalid JSON, disabled
hooks, conflicting cloud startup entries, or a different `attribution` value stop
generation with a repair instruction. Startup or environment persistence failures
produce actionable session context and a stderr reason; SessionStart cannot block
a session. Successful startup is silent on stdout. Commit both generated files.
Generation refuses symlink parents or destinations and hard-linked destinations.
Generation recreates its deleted tracked output files and requires unrelated
tracked inputs to remain readable.
`stll-toolchain-check` rejects missing, drifted, or undeclared tracked scripts,
missing or conflicting startup hooks, and missing or different attribution
settings with mandatory `cloud-setup-drift`.
Regenerate after changing the policy or declaration. `stll-cloud-setup --help`
prints usage without reading repository configuration.

| Environment phase       | Command                               |
| ----------------------- | ------------------------------------- |
| Networked install       | `bash .agents/cloud-setup.sh install` |
| Offline session startup | `bash .agents/cloud-setup.sh start`   |

Runtime installation rebuilds and verifies a missing or empty system CA bundle
before HTTPS downloads, including when the certificate package is already current.

Both commands can be rerun. Missing or unknown subcommands print usage and
exit 2; there is no implicit lifecycle mode. The script supports Ubuntu 24.04
with root access or passwordless sudo and fails when required capabilities
or pinned installations are unavailable. `install` provisions runtimes,
dependencies, and declared services; `start` refreshes the managed shell environment
and restores local services after
cached environments lose running processes. Services bind only to localhost.
System provisioning runs as root; frozen dependencies run as the invoking user
with that user's home and a private, user-owned Bun cache. Package installation
does not permit automatic downgrades.
Runtime commands and declared tools are exposed through `/usr/local/bin`, so a
fresh shell can use Bun, Node, Rust, and the tools without sourcing `.cargo/env`
or changing `PATH`. Rust proxies select the provisioned system toolchain.
Installation also writes `/etc/profile.d/stll-cloud.sh` and sources it from the
invoking user's Bash startup files. The profile puts pinned Node and Bun ahead
of inherited runtime directories while preserving unrelated paths and existing
startup settings. Rerunning installation does not duplicate these source entries.
If a newer Valkey package is already installed, provisioning fails rather than
downgrading it; use an environment compatible with the pinned release.
The environment file contains `NODE_ENV=test` and declared local connection
URLs, carries a generated ownership marker, and refuses an unowned file or
symlink. Configure the repository's test runner to load that file; migration
commands and repository adoption are separate configuration steps.

Environments may cache filesystems without preserving service processes.
Run `start` at every session start, including sessions that reuse installed files.
The supported OS, privileges, and pinned runtime requirements are checked explicitly.

### Network hosts

Downloads use a 20-second connection timeout, three retries, and a total deadline
(45 seconds for manifests and keys; 120 seconds for binary archives). APT uses
20-second Acquire timeouts, three retries, and a 180-second command deadline.
Rust provisioning commands have a 180-second deadline. Frozen dependency
installation uses a 20-second Bun HTTP idle timeout and a 240-second overall
deadline, including lifecycle scripts. Timeout failures name the download host
or the configured package hosts; a redirected download names its original host.

Allow these direct download hosts for the generated installer:

| Host                   | Downloads                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `nodejs.org`           | Node archives and SHA256 manifests                                                 |
| `github.com`           | Bun archives and checksums; pinned nextest, wasm-bindgen, gitleaks and uv releases |
| `static.rust-lang.org` | Pinned rustup-init, Rust manifests, toolchains, components and targets             |
| `www.postgresql.org`   | PostgreSQL repository signing key                                                  |
| `apt.postgresql.org`   | PostgreSQL packages and repository metadata                                        |
| `download.valkey.io`   | Pinned Valkey binary packages                                                      |

GitHub release downloads redirect to `release-assets.githubusercontent.com`;
allow that host as well. This includes Bun and the optional prebuilt tools.
Rust provisioning uses `static.rust-lang.org` for both distribution and update endpoints.

System prerequisites and the optional `time` package use the image's configured
Ubuntu apt repositories:
standard Ubuntu 24.04 images use `archive.ubuntu.com`, `security.ubuntu.com`,
or `ports.ubuntu.com`, depending on architecture. Images configured with a
mirror need that mirror's host instead. Frozen Bun installation also needs
the package registry (normally `registry.npmjs.org`) and any download hosts
referenced by that repository's lockfile or dependency lifecycle scripts.
Those repository-specific hosts are not chosen by this generator. `start`
performs no downloads.

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

The static guard follows the packer declared in the tracked release workflow.
With pnpm, it models `publishConfig` overrides for `exports`, `main`, `module`,
`types`, `typings`, `bin`, and `typesVersions`. npm does not apply these overrides,
so differing values fail; move the published entry into the source manifest.
`access` and `registry` are allowed publication metadata. Other overrides,
including `engines`, are rejected. Real npm and pnpm pack tests compare the
modeled contract with each tarball manifest.

Build adapters use the installed configuration loaders and bind their behavior to
tsdown 0.22.9, Vite 8.1.5, or @nuxt/module-builder 1.0.3 (unbuild 3.6.1 and
mkdist 2.4.1). They record final transform targets, including separate Nuxt module
and runtime entries. No syntax lowering records `esnext`.
Only exact single build invocations (`tsdown`, `vite build`, or
`nuxt-module-build build`) are supported. Shell composition, environment prefixes,
launchers, directory changes, workspace filters, CLI overrides, and pre/post build
lifecycle scripts fail.
Vite accepts its version-bound default plugin pipeline and the default
`@vitejs/plugin-vue` 6.0.8 factory; custom Vue compiler, template, script, and feature
options are unsupported. Nuxt accepts the version-bound builder and immutable target
marker; foreign branded callbacks are replaced with the installed canonical hook before execution. Unapproved plugins, output transforms, and execution-order changes fail. The static guard validates the supported configuration; the nightly runner validates the actual packed JavaScript. Add a reviewed adapter when adopting another build tool.

Vite libraries can generate declarations through the reviewed helper:

```ts
import { declarationOnlyDts } from "@stll/oxlint-config/declaration-only-dts";

export default {
  plugins: [
    declarationOnlyDts({
      directory: import.meta.dirname,
      include: ["src/**/*"],
      entryRoot: "src",
    }),
  ],
  build: { target: "es2022", lib: { entry: "src/index.ts", formats: ["es"] } },
};
```

This adapter requires consumer-installed `vite-plugin-dts` 5.0.3 and its
`unplugin-dts` 1.0.3 implementation. Its dependency scope must provide TypeScript
6.0.3 as `typescript` or the plugin's `@typescript/typescript6` fallback.
Unsupported versions fail explicitly.
The resolver proves a direct helper import and call in a literal plugin array;
raw declaration plugins, opaque plugin arrays, and additional emitters fail.
Options are closed and static: include/exclude, entryRoot, pathsToAliases,
compilerOptions.declarationMap=false, strictOutput=true, and declarationOnly=false. Hooks may
emit only `.d.ts`, `.d.mts`, `.d.cts`, and their maps. Bundle and on-disk non-declaration
bytes must remain unchanged across each declaration hook; this is checked during
the actual build, without a comparison build.

Nuxt modules can set both emitted targets without replacing the builder's entries:

```ts
import { nuxtModuleTarget } from "@stll/oxlint-config/build-target";

export default { hooks: { "build:before": nuxtModuleTarget("es2022") } };
```

The Nuxt adapter recognizes the immutable marker across module formats without executing a foreign callback. It captures the normalized configuration before cleanup or output writes. The built
publish-contract CLI is also checked against a TypeScript configuration and relative
TypeScript import on the package's minimum supported Node release.

Packed-artifact checks run nightly, while the static contract check runs per PR.
Every packed `.js`, `.mjs`, and `.cjs` file is checked, including non-entry chunks
and executables. The actual packed manifest must match the committed contract.
Acorn 8.15.0 applies the strictest declared ECMAScript target (`es5`, `es2015`
through `es2025`); the provisioned consumer Node also parses every file with
`--check`, without executing artifact code. `esnext` and supported Node targets use the native consumer Node bound.
Node target identifiers follow the same grammar and compatibility rule as the
static contract; no older Node-to-ECMAScript mapping is inferred. Browser targets
are unsupported here: declare an explicit ECMAScript year. Types-only contracts reject any packed JavaScript. Nested
package manifests and explicit module extensions determine parsing mode.
Linked syntax inputs and unsafe archive paths fail before staging.

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
Day of week is 0–6 (SUN–SAT), matching the [GitHub Actions schedule contract](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule); numeric 7 is unsupported. The combined schedules must cover every weekday with unrestricted month and date fields, so weekly or seasonal schedules cannot satisfy the daily contract. Public packages require a semver-valid version. Published workspace packages under a `vendor` directory are unsupported; the contract CLI reports them rather than omitting them. `bundleDependencies` and `bundledDependencies` are unsupported because artifact staging does not install a bundled dependency tree; remove these fields before declaring consumer checks.
`workflow_dispatch` may also be enabled. That job calls the shared
`package-consumer-compat.yml` workflow at its approved immutable policy pin, with
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
canonical lowercase, URL-safe npm names (at most 214 characters), with no traversal components. The runner verifies
the official Node archive checksum and exact runtime/package-manager versions,
uses the oldest published React satisfying the package peer range and, when ReactDOM is required, its compatible renderer peer range, typechecks with
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

## Toolchain changes and typecheck probes

`stll-toolchain-changed --since <git-ref>` compares committed snapshots at the
reference and `HEAD`. Fetch the reference and its history before running it.
It prints one JSON object with `changed`, `tools`, and `status`; the detector
exits successfully even when history is unreadable, reporting `changed: true`
and `status: "unreadable"`. Use `changed` to force the full CI depth on both
pull requests and merge-queue runs. An unreadable snapshot never skips checks.

Run repository-installed tools only after the workflow's existing trust decision.
The mandatory `workflow-trust` rule applies to PR workflows declaring a
`trust-check` job. Repository execution requires a direct dependency and a
condition requiring its `trusted == 'true'` output for every PR trigger.
Before that boundary, commands must match a small metadata allowlist: shell
output and bounded comparisons, static file reads, simple jq/yq selectors,
selected read-only Git commands, and GET-only GitHub CLI reads. The trust job's
`if`/`elif` comparisons and writes to `GITHUB_OUTPUT` use the same checks.
Job containers and nonempty services require the job-level trust gate because
they start before steps and supply executable code. A step condition cannot
authorize their startup. Digest pinning alone does not approve an image for
pre-trust execution; the guard has no implicit image approval catalog.
Pinned external step actions without inputs may run before trust; local actions
and unknown step action forms require the gate. Every job-level reusable workflow
call requires the job-level trust condition, including pinned calls without inputs.

Interpreters, sourced files, executable paths, package managers (including
metadata and script-disabled install modes), launchers, custom shells, and
unknown commands or syntax require trust. File operands are data only for the
explicit read commands; they never authorize a repository executable. Unsupported
options and query programs also require the gate. For example, gate the entire
detector job, including dependency installation:

```yaml
check-changes:
  needs: [trust-check]
  if: >-
    always() && !cancelled()
    && ((github.event_name != 'pull_request'
         && github.event_name != 'pull_request_target')
        || needs.trust-check.outputs.trusted == 'true')
  runs-on: ubuntu-latest
  steps:
    # Check out, set up Bun, install dependencies, then run the shared detector.
    - run: bunx --no-install stll-toolchain-changed --since "$BASE_REF"
```

Actions interpolation is checked before shell quoting or comments. Only the
bounded identity expressions `github.sha`, `github.run_id`, `github.run_attempt`
and `github.repository` may appear directly in pre-trust scripts. Other contexts,
functions and matrix values require environment indirection or the trust gate;
the guard does not infer that an expression is safe from its shell quotes.
Pass contributor-controlled metadata through a supported data environment key
(`PR_TITLE`, `HEAD_REF`, `ISSUE_BODY` or `COMMENT_BODY`) and quote its expansion:

```yaml
- env:
    PR_TITLE: ${{ github.event.pull_request.title }}
  run: echo "$PR_TITLE"
```

The trust job must classify each PR trigger used by the workflow. Main/manual
jobs remain runnable when the PR-only trust job is skipped. Job or step
conditions may prove that execution is limited to non-PR events; event string
comparisons follow Actions case-insensitive equality. The guard
proves only supported static metadata commands and boolean conditions; unknown
commands and conditions cannot authorize execution. It does not validate the
trust job's authorization policy.
Workflows with no declared trust job retain their existing fork-CI policy.

The comparison includes Bun declarations, Node selectors and support ranges,
resolved TypeScript compiler versions (including workspace and compatibility
aliases), oxlint, oxlint-tsgolint, oxfmt, and shared tooling pins. Lockfile
resolutions determine installed package versions; manifest ranges alone do not.
Resolution locations and importer bindings are retained: swapping compiler
versions between workspaces cannot look unchanged. Compiler specifier changes
run parity even when the resolved release version is unchanged. Unknown lock
shapes and ambiguous resolutions report an unreadable snapshot. Supported text
locks include Bun JSONC (schema 0/1), pnpm YAML (5.4/6/9), npm package-lock/
shrinkwrap (1/2/3), and bounded Yarn Classic/Berry shapes; a binary-only Bun lock
cannot be compared without executing Bun.
Workflow/action and Docker definition edits conservatively force full CI.
Unrelated application dependency changes do not force compiler parity.
Setup-action runtime selectors and their tracked version-file contents must
identify an exact stable release. Floating selectors,
ranges, expressions, empty
values, or omitted runtime versions report an unreadable snapshot and run parity
even when their committed text is unchanged.

On pull requests, run the repository's ordinary Bun typecheck and the probe,
then select parity using the same detector:

```sh
stll-typecheck-probe --project packages/api/tsconfig.json --seed-dir packages/api/src -- bun run typecheck
stll-typecheck-parity --changed-since origin/main --project packages/api/tsconfig.json
```

The probe writes an exclusive temporary TypeScript file in the declared
project, requires the command to fail with TS2322 attributed to that file, removes
it, and requires the clean command to pass. Use `--seed-dir` to select a repository-relative directory inside the project;
the default is the config directory. The config must include the seed directory;
excluded seeds fail instead of producing a vacuous pass. Commands are argv,
not shell expressions. Cleanup also runs on failure and handled termination.
Repeat the probe for independently checked projects as needed.

Conditional parity runs when Bun, TypeScript, or shared declarations change;
otherwise it prints `parity skipped: toolchain unchanged since ...`. An unreadable
reference runs full parity. Nightly jobs omit `--changed-since` to run full parity.
Node and lint-tool changes still force full CI through the shared detector.

Workflow, composite-action, Docker, mise, and tool-version declarations are
conservatively fingerprinted for compiler parity, including referenced tracked
setup-action version files (Node, Bun, Python, Go, Java and other runtimes).
Rust toolchain-file selectors and conventional runtime files are included;
cache-dependency-path is not a runtime selector. Compose and Kubernetes image
definitions are conservatively fingerprinted alongside Dockerfiles. Catalog and unresolved declaration changes also force parity;
an unclassifiable reference runs full parity. This may run parity for unrelated
edits to these declaration files. Active installed compiler comparisons still
use the owning lockfile resolutions.

Compiler patch declarations, lockfile patch hashes, and their tracked patch files
are included even when the compiler version is unchanged. Compiler patch-package
files are included too. Missing referenced compiler patches fail closed; unrelated
package patches do not trigger compiler parity.

Compiler manifest specifiers and complete compiler lock entries form part of the
change identity, including resolved URLs, integrity, commits, checksums and patch
hashes. Changing a source at the same release version runs parity. Local compiler
sources without an immutable byte identity fail closed; a version alone does not
identify a local directory. Git compiler sources require a full commit identity.
Supported text locks include Bun, npm, pnpm and bounded
Yarn Classic/Berry shapes; unrecognized lock shapes run parity. Yarn compiler
`patch:` protocols are unsupported and run parity because their patch bytes are
not represented by the lock checksum alone.

## Rust selectors

The shared `toolchain.json` Rust pin applies to `rust-toolchain(.toml)`, runtime
managers, workflow Rust action/reusable-workflow inputs and `RUSTUP_TOOLCHAIN`,
Cargo/rustup commands in scripts, and Rust Docker/service images. An omitted
`dtolnay/rust-toolchain` version selects a floating action default and fails.
Cargo manifest `rust-version` remains an MSRV floor at or below the shared pin.

Only `rustExceptions` in the consumer's root `stll-toolchain.json` can authorize
another exact stable release. Each record contains exactly `pin`, `reason`,
`tracking` (a GitHub issue URL) and `expires` (a future `YYYY-MM-DD` date).
Channels, expired records and `rust-version` rule opt-outs fail validation.
See the [root policy guide](../../README.md) for a complete declaration.
