---
"@stll/oxlint-config": patch
---

The generated cloud setup runs the frozen dependency install at every start instead of skipping it on a lockfile stamp. The install reads every input the package manager uses and changes nothing on a current tree, so a manifest or patch edit without a regenerated lockfile is refused and a deleted or replaced `node_modules` is reinstalled.
