---
"@stll/oxlint-config": patch
---

Toolchain change detection reads a setup version-file selector under a same-repository `actions/checkout` path, such as `base/package.json` after a checkout with `path: base`, as the repository's own tracked file, so the repository is compared instead of being reported as unreadable.
