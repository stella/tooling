---
"@stll/typescript-config": minor
"@stll/oxlint-plugin": patch
"@stll/time": patch
"@stll/test-kit": patch
---

`@stll/typescript-config` no longer peers on `typescript`: `bun check` embeds the checker. The other packages emit declarations without a TypeScript install (oxc for `@stll/oxlint-plugin`, `@stll/time` and `@stll/test-kit`) and type check with `bun check --no-pretty --all --project=tsconfig.json`; their declared types are unchanged.
