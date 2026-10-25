---
"@stll/oxlint-config": patch
"@stll/oxlint-plugin": patch
"@stll/time": patch
"@stll/test-kit": patch
---

Package `typecheck` scripts run `bun check --no-pretty --all --project=tsconfig.json`, and `@stll/oxlint-config` and `@stll/oxlint-plugin` no longer list their own `typescript` development dependency; the repository root keeps the one TypeScript install that typecheck parity and declaration builds use.
