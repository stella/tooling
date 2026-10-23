---
"@stll/oxlint-config": patch
---

The generated cloud setup skips the dependency install only when the stamp inside the installed `node_modules` still matches every install input: the lockfile, each workspace `package.json`, the patch files they reference, `bunfig.toml` and `.npmrc`. A manifest or patch edit without a regenerated lockfile now runs the frozen install, which refuses it, and a deleted or replaced `node_modules` reinstalls.
