---
"@stll/oxlint-config": patch
---

Toolchain change detection reads a setup wrapper action such as `setup-bun-cached` as the runtime its name starts with, so its `bun-version-file` selector is compared instead of the repository being reported as unreadable.
