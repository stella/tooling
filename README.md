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
  assertions, incomplete union-keyed records, and raw DOM HTML sinks.
- `rust/`: source-of-truth Rust formatting, lint, and Cargo profile templates.
- `rust-lints/`: Dylint libraries for stella-specific Rust rules.

Repo-specific stella rules stay in the consuming repo: domain authorization,
i18n, generated native artifacts, benchmark exceptions, and package-specific
ignores.

## Usage

Install the shared TypeScript and oxlint packages:

```bash
bun add -d @stll/typescript-config @stll/oxlint-config @stll/oxlint-plugin @oxlint/plugins oxlint oxlint-tsgolint typescript
```

The shared defaults require TypeScript 7.0.2 or newer, oxlint 1.75.0 or
newer, and oxlint-tsgolint 7.0.2001 or newer. Pin the current versions from
`@stll/typescript-config/toolchain.json`; do not use the deprecated
oxlint-tsgolint 0.x line.

`toolchain.json` defines two supported TypeScript install layouts:

- `direct` installs TypeScript 7 as `typescript` and runs the normal `tsc`
  binary. Prefer this when every framework and compiler-API consumer supports
  TypeScript 7.
- `split-compatibility` keeps TypeScript 6 as `typescript` for incompatible
  compiler-API consumers, then installs TypeScript 7 as `@typescript/native`
  and invokes that binary for typechecking.

TypeScript 6 is compatibility-only. Use the split layout only for a command
that loads one of the peer blockers listed in `toolchain.json`, or for code
that imports the TypeScript compiler API. Remove the compatibility install when
the blocker accepts TypeScript 7. The shared config's peer range accepts both
layouts; the compiler and typecheck command in each layout remain TypeScript 7.

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

When using `no-unsafe-inner-html`, disable the blanket `react/no-danger` rule;
the portable rule permits static and provably sanitized HTML while rejecting
untrusted values.

`react/react-compiler` is part of the default rule set and requires
**oxlint >= 1.70**. It is a nursery rule upstream, so its diagnostics may
change between oxlint minor versions; re-audit findings after bumping the
oxlint devDependency. oxlint has no bulk-suppression/baseline mechanism as of
1.72.0 ([oxc-project/oxc#10549](https://github.com/oxc-project/oxc/issues/10549)
tracks the upstream feature request and is still open). A repo adopting this
rule against an existing findings backlog should carve out temporary
`overrides` entries per legacy path (or per rule, at `"off"`) and fix forward,
rather than expecting a generated suppression file.

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
    "typecheck": "tsc --noEmit",
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
