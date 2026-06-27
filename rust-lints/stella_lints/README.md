# stella_lints

Custom Dylint rules for stella Rust repositories.

## Lints

### `stella_lowercase`

Checks string literals for `Stella` and asks for lowercase `stella`.

This mirrors the shared oxlint rule for TypeScript code. Public docs,
diagnostics, and logs should use the lowercase project name.

#### Example

```rust
let product = "Stella tooling";
```

Use instead:

```rust
let product = "stella tooling";
```
