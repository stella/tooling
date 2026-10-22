---
"@stll/oxlint-config": minor
---

The formatter policy rejects a repository `ignorePatterns` entry in `bunfig.toml [fmt]` that covers a workspace package, so `bun fmt --check` cannot silently skip package sources, and it rejects negated entries, so every listed pattern only removes files. Patterns for generated or vendored paths inside a package stay allowed.
