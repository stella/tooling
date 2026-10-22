---
"@stll/oxlint-config": minor
---

Adopt Bun 1.4.4 and make `bun fmt` the only formatter. The shared toolchain drops the oxfmt pin and adds a `formatter` policy: the new `formatter-policy` rule rejects oxfmt, Prettier, Biome and dprint dependencies, commands and configuration files, requires the shared style in the root `bunfig.toml` `[fmt]` table, `bun fmt --staged` in lefthook `pre-commit`, and a whole-repository `bun fmt --check` workflow step.
