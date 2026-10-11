---
"@stll/oxlint-config": minor
---

Make `library()` framework-neutral and add `react: { files: [...] }` to enable React and React Compiler rules only for consumer-selected files. Consumers upgrading from global React enforcement should explicitly select their React components and hooks.

Breaking change for direct export users: `libraryRules` no longer contains React or React Compiler rules, and `libraryPlugins` no longer contains `react`. These exports are now framework-neutral. Migrate to `library({ react: { files: [...] } })`, or compose a file-scoped override with `plugins: [...libraryPlugins, "react"]` and `rules: { ...reactRules, ...consumerRules }`. Preserve any additional consumer plugins in that scoped list. No compatibility aliases are provided.

Later consumer overrides that configure React rules must explicitly include the React plugin in their own file-scoped `plugins` list, because oxlint resolves each override against the framework-neutral base plugin list.
