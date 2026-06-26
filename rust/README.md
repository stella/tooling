# stella Rust policy

Shared Rust formatting, lint, and Cargo profile templates for stella public
packages.

Cargo cannot import `[lints]`, `[profile]`, or `clippy.toml` from another
package. Treat this directory as the source of truth and copy the templates
into Rust repositories when adding or refreshing Rust support.

## Files

- `rustfmt.toml`: formatting baseline.
- `clippy.toml`: portable disallowed APIs and lint thresholds.
- `cargo-root.toml`: root `Cargo.toml` snippets for single-crate packages.
- `cargo-workspace.toml`: root `Cargo.toml` snippets for workspaces.
- `cargo-config.toml`: optional `.cargo/config.toml` aliases for local and CI
  checks.
- `dylint.toml`: Dylint library config for stella-specific Rust rules.

## Recommended Checks

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo dylint --workspace --all
cargo test --workspace --all-features --locked
cargo audit
cargo deny check
```

For pure Rust crates that do not call FFI at test runtime, also run:

```bash
cargo miri test --workspace
```

## Adoption

1. Copy `rustfmt.toml` and `clippy.toml` to the repository root.
2. Copy the relevant `[workspace.lints]` or `[lints]` section into
   `Cargo.toml`.
3. Copy `dylint.toml`, pin the `stella/tooling` `rev`, and install
   `cargo-dylint` plus `dylint-link`.
4. Copy the release/profile section into the root `Cargo.toml`.
5. Add `[lints] workspace = true` to each workspace member, if using a
   workspace.
6. Add local exceptions only with a short reason at the narrowest scope.

Keep repo-specific policy in the consuming repo. Examples: custom filesystem
wrappers, generated native artifacts, benchmark exceptions, or intentionally
unsafe FFI shims.

The shared baseline targets Rust 2024. Repositories still on Rust 2021 can copy
the templates and temporarily set `edition = "2021"` in `rustfmt.toml` until
they migrate.
