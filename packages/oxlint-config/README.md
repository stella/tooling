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
without the checkout prefix, in `sparse-checkout`. This applies in either cone
mode and to delegated sources. Dynamic, empty, glob, negation, or unsupported
sparse configurations fail; a cone-mode input alone is insufficient. Directory
entries cannot substitute for the selected file.
Other nonempty, nonconstant GitHub expression refs on same-repository checkouts
(including `${{ job.workflow_repository }}`) delegate a safe static version-file selector
to that checkout. The CLI reports delegation on stdout without validating the
current source's version file. Literal refs and unpaired `${{ github.sha }}` /
`${{ job.workflow_sha }}` remain rejected.
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
An included member may depend on the exact TypeScript 6 compatibility API at runtime
or as a peer when that shared install uses the complete split layout. Ambiguous or
partial layouts do not grant this allowance.

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

Services are optional within the declared list: use `[]` for runtimes and
dependencies only. No `cloud` declaration means no cloud setup script.
`envFile` must be a canonical repository-relative path; its existing parent
must be safe at runtime. Track an exact stable Node patch in root
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
