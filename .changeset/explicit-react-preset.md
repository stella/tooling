---
"@stll/oxlint-config": minor
---

Make `library()` framework-neutral and add `react: { files: [...] }` to enable React and React Compiler rules only for consumer-selected files. Consumers upgrading from global React enforcement should explicitly select their React components and hooks.
