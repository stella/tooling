# stella Rust source checks

`stella_source_lint` enforces repository policy using the shared stable Rust
pin. It parses Rust with `syn`; no compiler-private components are required.

## Install and run

Pin the tooling commit used by the consuming repository:

```bash
cargo install --git https://github.com/stella/tooling --rev <sha> --locked stella_source_lint
stella_source_lint .
```

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

## Development

```bash
cargo test --manifest-path rust-lints/stella_source_lint/Cargo.toml --locked
```

The tests retain the former UI examples, cover string and boundary semantics,
and mutate a passing source to assert a nonzero CLI status with its source line.
