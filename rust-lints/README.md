# stella Rust lints

Custom Dylint libraries for stella Rust repositories.

These rules are the Rust equivalent of shared custom oxlint rules: they enforce
stella-specific policy that Clippy cannot know about.

## Libraries

- `stella_lints`: shared Rust house rules.

## Current Rules

- `stella_lowercase`: flags string literals containing `Stella`; use lowercase
  `stella` in public docs, diagnostics, and logs.

## Consumer Setup

Install the Dylint runner:

```bash
cargo install cargo-dylint dylint-link
```

Copy `rust/dylint.toml` to the consuming repository root, pin the
`stella/tooling` `rev`, then run:

```bash
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo dylint --workspace --all
```

Keep repo-specific exceptions narrow and local. If a rule is broadly wrong,
fix it here instead of suppressing it in every consuming repository.
