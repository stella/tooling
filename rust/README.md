# stella Rust policy

Shared Rust formatting, lint, and Cargo profile templates for stella public
packages.

Cargo cannot import `[lints]`, `[profile]`, or `clippy.toml` from another
package. This directory remains the source of truth. The published
`@stll/oxlint-config` CLI embeds these templates during its build and generates
consumer files; consumers check drift in CI.

## Files

- `rustfmt.toml`: formatting baseline.
- `clippy.toml`: portable disallowed APIs and lint thresholds.
- `cargo-root.toml`: root `Cargo.toml` snippets for single-crate packages.
- `cargo-workspace.toml`: root `Cargo.toml` snippets for workspaces.
- `cargo-config.toml`: optional `.cargo/config.toml` aliases for local and CI
  checks.

## Recommended Checks

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo ci-stella-lint
cargo test --workspace --all-features --locked
cargo audit
cargo deny check
```

## Adoption

Install `@stll/oxlint-config` and commit `stll-rust-policy.json`:

```json
{ "kind": "single-crate" }
```

For a workspace use `{ "kind": "workspace" }`. Members derive from Cargo's
`workspace.members` (including globs), `workspace.exclude`, and in-tree path
dependencies, including inherited and target-specific dependencies. Root
packages inherit the workspace policy too. Discovery stays inside the repository;
symlinked members and escaping member patterns fail before writes.

Run from the repository root:

```bash
bunx --no-install stll-rust-policy
bunx --no-install stll-rust-policy --check
```

`--config <path>` selects another JSON input. `--help` prints usage. Generation
merges policy values into existing Cargo manifests and `.cargo/config.toml`,
and merges `rustfmt.toml` and `clippy.toml`. Other values (dependencies, package
metadata, workspace members/resolver, custom aliases, build settings, and additional
lint rules) remain intact. TOML comments and layout are replaced by canonical
serialization; review the first generated diff before committing it. Missing
Cargo manifests and conflicting workspace member lint tables fail before any
file is written. Outputs must be ordinary files and directories, without links.
`--check` exits nonzero for drift and never writes.

Workspace members receive `[lints] workspace = true`. Remove their local lint
tables first. Shared values are always regenerated; express a project exception
in the input with its reason, rather than editing generated values:

```json
{
  "kind": "single-crate",
  "exceptions": [
    {
      "file": "rustfmt.toml",
      "path": ["edition"],
      "value": "2021",
      "reason": "Keep Rust 2021 formatting until the edition migration"
    }
  ]
}
```

Exceptions replace existing policy leaves of the same value type. They cannot
add policy paths. Rust 2024 remains the shared baseline. Custom filesystem
wrappers, generated artifacts, and FFI lint exceptions belong in the consuming
repository input or narrowly scoped source attributes.

Install the stable source checker from an exact tooling commit:

```bash
cargo install --git https://github.com/stella/tooling --rev <sha> --locked stella_source_lint
cargo ci-stella-lint
```

Replace `<sha>` with the adopted tooling commit. The checker enforces the
lowercase product name in string literals; doc comments are excluded.

Use the exact stable Rust pin in `packages/oxlint-config/toolchain.json`.
Optional fuzzing can use `cargo fuzz run <target> -s none` on stable Rust;
ordinary CI retains the deterministic unit and source-lint checks above.

Hawk 0.1.11 requires the temporary exact Rust 1.97.1 exception documented in
[tracking issue #99](https://github.com/stella/tooling/issues/99). Declare it in
`stll-toolchain.json` with the compatibility reason, tracking URL and expiry
2026-11-11; retain the shared stable pin for ordinary Rust checks.

Generated comments record the exact policy leaves owned by the current release.
Later generation removes those leaves before applying the new template, so
retired policy keys disappear while unrelated values survive. Ownership markers
are validated and Cargo markers cannot name dependencies, package metadata,
workspace membership, resolver, or custom profile tables. Keep these comments
with generated files. The first generation of an unmarked file cannot identify
retired values from older manual copies; review and remove those once at adoption.

The root manifest also records the generated workspace member paths. When
membership, exclusions, or path dependencies change, generation retires owned
lint inheritance in former member manifests while retaining unrelated values.
After full validation, the root records the union of old and current members
before member writes; it drops retired obligations only after those writes.
Interrupted enrollment and cleanup therefore remain recoverable. Former member files still require safe repository paths and their
generated ownership comments; missing former manifests need no cleanup. The
first adoption of a manifest without a member index cannot discover previously
managed members that are already absent from the current workspace.

Cargo member globs include hidden directories. Exclusions are literal path
prefixes with directory boundaries; literal member paths override them, while
glob-expanded members remain subject to exclusions. Every selected member
directory must contain a manifest; missing manifests fail before writes.
Traversal checks ancestor directories without reading non-member manifests.
