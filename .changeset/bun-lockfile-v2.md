---
"@stll/oxlint-config": patch
---

Toolchain change detection reads Bun text lockfiles at version 2, which share the version 1 layout, so a repository with such a lockfile is compared instead of being reported as unreadable.
