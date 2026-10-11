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

1. Copy `rustfmt.toml` and `clippy.toml` to the repository root.
2. Copy the relevant `[workspace.lints]` or `[lints]` section into
   `Cargo.toml`.
3. Install the stable source checker from an exact tooling commit and copy the
   `ci-stella-lint` alias from `cargo-config.toml`:

   ```bash
   cargo install --git https://github.com/stella/tooling --rev <sha> --locked stella_source_lint
   cargo ci-stella-lint
   ```

   Replace `<sha>` with the adopted tooling commit. The checker enforces the
   lowercase product name in string literals; doc comments are excluded.

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

Use the exact stable Rust pin in `packages/oxlint-config/toolchain.json`.
Optional fuzzing can use `cargo fuzz run <target> -s none` on stable Rust;
ordinary CI retains the deterministic unit and source-lint checks above.

Hawk 0.1.11 requires the temporary exact Rust 1.97.1 exception documented in
[tracking issue #99](https://github.com/stella/tooling/issues/99). Declare it in
`stll-toolchain.json` with the compatibility reason, tracking URL and expiry
2026-11-11; retain the shared stable pin for ordinary Rust checks.
