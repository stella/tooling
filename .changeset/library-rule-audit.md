---
"@stll/oxlint-config": major
"@stll/oxlint-plugin": patch
"@stll/test-kit": patch
---

`library()` enables more bug-shaped rules outside oxlint's default correctness category: `eqeqeq` (with `== null` allowed), `no-var`, `prefer-const`, `no-case-declarations`, `default-case-last`, `array-callback-return`, `no-self-compare`, `no-unneeded-ternary`, `no-useless-concat`, `no-useless-constructor`, `preserve-caught-error`, `no-implied-eval`, `no-new-func`, `no-extend-native`, `no-proto`, TypeScript `ban-ts-comment`, `no-require-imports`, `no-empty-object-type`, `no-unsafe-function-type`, `no-unnecessary-type-constraint`, `no-confusing-non-null-assertion`, `no-deprecated`, `no-unnecessary-type-assertion`, `no-unnecessary-template-expression`, `no-unnecessary-boolean-literal-compare`, `restrict-plus-operands`, `no-unsafe-enum-comparison`, `no-mixed-enums`, `prefer-promise-reject-errors`, `use-unknown-in-catch-callback-variable`, `prefer-includes`, `prefer-string-starts-ends-with` and `prefer-find`, unicorn `prefer-node-protocol`, `prefer-array-flat-map`, `no-instanceof-builtins`, `no-accessor-recursion` and `require-post-message-target-origin`, `oxc/misrefactored-assign-op`, import `no-duplicates`, `no-self-import`, `no-absolute-path` and `no-empty-named-blocks`, and `promise/no-multiple-resolved`. Files selected with `react.files` now also get React's correctness rules (keys, duplicate props, state mutation, removed APIs), except `exhaustive-deps` and `jsx-no-undef`, which the compiler rules and TypeScript already cover.

The test override now matches nested `__tests__/` and `__test__/` folders and `.mts`, `.cts`, `.mjs` and `.cjs` test files. Its globs were anchored at the config directory, so tests inside packages did not get it.
