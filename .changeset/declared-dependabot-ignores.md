---
"@stll/oxlint-config": minor
---

Accept reviewed repository Dependabot ignores in `stll-toolchain.json` `dependabotIgnores`. `stll-dependabot` appends them after the shared-pin ignores, and `stll-toolchain-check` accepts exactly the shared pins plus the declarations. Declarations need a reason and cannot name or match a shared pin.
