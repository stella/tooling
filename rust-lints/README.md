# stella Rust source checks

`stella_source_lint` enforces repository policy using the shared stable Rust
pin. It parses Rust with `syn`; no compiler-private components are required.

## Install and run

Pin the tooling commit used by the consuming repository:

```bash
cargo install --git https://github.com/stella/tooling --rev <sha> --locked stella_source_lint
cargo stella-lint .
```

Installation provides both `cargo-stella-lint` (invoked as `cargo stella-lint`)
and `stella_source_lint` (invoked directly). `stll-rust-policy` writes the
`cargo ci-stella-lint` alias from [the Cargo alias template](../rust/cargo-config.toml)
into `.cargo/config.toml`; see [Rust adoption](../rust/README.md#adoption).

The command recursively checks `.rs` files under its paths (the current directory
by default). Findings print `file:line:column` diagnostics and exit with status 1.
Unreadable or invalid Rust files exit with status 2.

## Policy

`stella_lowercase` flags string literals containing the word `Stella`; write
`stella` instead. `Stellar`, `MyStella`, and `Stella_name` pass. A word boundary is
any character other than a Unicode alphanumeric character or underscore, matching
the former compiler lint.

Ordinary strings, raw strings, escaped strings, and literal macro arguments are
checked. Comments, doc comments, attributes (including `#[doc = "..."]`), byte
strings, and C strings are ignored. Parsing does not expand macros or evaluate
`cfg`: literal macro arguments and inactive source are checked, while strings
produced by macro expansion or loaded with `include_str!` are outside this source
check.

Directories named `fuzz`, `target`, `generated`, or `.git`, and files named
`generated.rs` or ending in `.generated.rs`, are excluded. Symlinks are not
followed. Exclusions apply at every path depth, including explicitly supplied
paths.

## Explicit fixture configuration

Tests are checked by default. To opt out known fixture files, pass a JSON
configuration explicitly; paths are relative to the configuration file's parent:

```json
{
  "fixturePaths": ["tests/fixtures", "tests/source_lint.rs"]
}
```

```bash
cargo stella-lint --config stella-source-lint.json .
```

`fixturePaths` is the only configuration field. Entries must exist and name
exact Rust files under `tests/`, or directories at or below `tests/fixtures/`.
A listed file exempts only that file; a listed fixture directory exempts its
descendants. Globs, absolute paths, traversal, symlinks, production paths, and
a blanket `tests` directory are rejected. Unlisted test files remain checked;
there are no inline suppressions. Invalid configuration exits with status 2.

The checker declares its own test fixtures in
[`stella-source-lint.json`](stella_source_lint/stella-source-lint.json). Its
integration tests lint its production sources with that configuration.

## Development

```bash
cargo test --manifest-path rust-lints/stella_source_lint/Cargo.toml --locked
```

The tests retain the former UI examples, cover string and boundary semantics,
and mutate a passing source to assert a nonzero CLI status with its source line.
