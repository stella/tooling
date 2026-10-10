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

Opt-outs apply to the entire repository for that rule. Unknown or duplicate
rules, empty reasons, and malformed configuration fail validation. See the
[shared toolchain reference](https://github.com/stella/tooling#shared-toolchain)
for the schema, rule list, runtime support ranges, and generated Dependabot
template.
