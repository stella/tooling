---
"@stll/oxlint-config": patch
---

Preserve omitted rootDir and outDir in typecheck-only parity projects so files outside the config directory retain the original diagnostics. Add real original-versus-temporary compiler regressions for default, output-directory, and composite configurations.
