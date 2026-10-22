---
"@stll/oxlint-config": minor
---

The shared `bun` value is a minimum. A repository pins one exact Bun release at or above it in its root `packageManager`, and `bun-types`, setup-bun selectors, images, version files and the generated cloud setup must equal that release, so a repository can take a newer Bun without a policy release.
