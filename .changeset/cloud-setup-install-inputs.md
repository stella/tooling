---
"@stll/oxlint-config": patch
---

The generated cloud setup skips the dependency install only when its stamp still matches every install input (the lockfile, each workspace `package.json`, `bunfig.toml` and `.npmrc`) and the same installed `node_modules` tree. A manifest edit without a regenerated lockfile now runs the frozen install, which refuses it, and a deleted, replaced or empty `node_modules` reinstalls.
