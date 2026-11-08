# @stll/test-kit

## 0.4.2

### Patch Changes

- [#265](https://github.com/stella/tooling/pull/265) [`c655522`](https://github.com/stella/tooling/commit/c65552265257619469316394cc634cd15692cd35) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `library()` enables more bug-shaped rules outside oxlint's default correctness category: `eqeqeq` (with `== null` allowed), `no-var`, `prefer-const`, `no-case-declarations`, `default-case-last`, `array-callback-return`, `no-self-compare`, `no-unneeded-ternary`, `no-useless-concat`, `no-useless-constructor`, `preserve-caught-error`, `no-implied-eval`, `no-new-func`, `no-extend-native`, `no-proto`, TypeScript `ban-ts-comment`, `no-require-imports`, `no-empty-object-type`, `no-unsafe-function-type`, `no-unnecessary-type-constraint`, `no-confusing-non-null-assertion`, `no-deprecated`, `no-unnecessary-type-assertion`, `no-unnecessary-template-expression`, `no-unnecessary-boolean-literal-compare`, `restrict-plus-operands`, `no-unsafe-enum-comparison`, `no-mixed-enums`, `prefer-promise-reject-errors`, `use-unknown-in-catch-callback-variable`, `prefer-includes`, `prefer-string-starts-ends-with` and `prefer-find`, unicorn `prefer-node-protocol`, `prefer-array-flat-map`, `no-instanceof-builtins`, `no-accessor-recursion` and `require-post-message-target-origin`, `oxc/misrefactored-assign-op`, import `no-duplicates`, `no-self-import`, `no-absolute-path` and `no-empty-named-blocks`, and `promise/no-multiple-resolved`. Files selected with `react.files` now also get React's correctness rules (keys, duplicate props, state mutation, removed APIs), except `exhaustive-deps` and `jsx-no-undef`, which the compiler rules and TypeScript already cover.

  The test override now matches nested `__tests__/` and `__test__/` folders and `.mts`, `.cts`, `.mjs` and `.cjs` test files. Its globs were anchored at the config directory, so tests inside packages did not get it.

- [#267](https://github.com/stella/tooling/pull/267) [`7a12523`](https://github.com/stella/tooling/commit/7a12523ec5c12aeb52caad86a8e821c88c658f01) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `library()` enables `typescript/no-unsafe-argument`, `no-unsafe-assignment`, `no-unsafe-call`, `no-unsafe-member-access` and `no-unsafe-return`, so an `any` from `JSON.parse`, untyped libraries or an unresolved import can no longer flow into typed code unchecked. Test files keep reporting calls, member access and returns but allow passing and storing `any` values such as asymmetric matchers. JavaScript files are exempt. The rules are exported as `unsafeAnyRules` so a consumer can turn them off per directory while adopting them, and the two exemptions as `unsafeAnyOverrides`; `libraryOverrides` does not include them, so a config that spreads it over another preset keeps that preset's scope for these rules.

## 0.4.1

### Patch Changes

- [#242](https://github.com/stella/tooling/pull/242) [`6755ea1`](https://github.com/stella/tooling/commit/6755ea12323e20c24835cc77040fe43fe3c5c2bd) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Validate the database-clock helpers with PGlite 0.5.11, including its readiness-aware close and extended-query protocol fixes.

- [#242](https://github.com/stella/tooling/pull/242) [`6755ea1`](https://github.com/stella/tooling/commit/6755ea12323e20c24835cc77040fe43fe3c5c2bd) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Validate the database-clock SQL fragments against Drizzle 1.0 RC5 while retaining the optional RC4-compatible peer contract.

## 0.4.0

### Minor Changes

- [#228](https://github.com/stella/tooling/pull/228) [`109a8fe`](https://github.com/stella/tooling/commit/109a8fe68520c267ff35f0186ae1b52cf575d9f9) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export `rejectionOf(promise)`, which returns the reason a promise rejects with and fails the test with the resolved value when it resolves instead.

## 0.3.1

### Patch Changes

- [#221](https://github.com/stella/tooling/pull/221) [`55c8622`](https://github.com/stella/tooling/commit/55c8622809b02eac3b527facacbecf53660474a6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `@stll/typescript-config` no longer peers on `typescript`: `bun check` embeds the checker. The other packages emit declarations without a TypeScript install (oxc for `@stll/oxlint-plugin`, `@stll/time` and `@stll/test-kit`) and type check with `bun check --no-pretty --all --project=tsconfig.json`; their declared types are unchanged.
- Updated dependencies [[`55c8622`](https://github.com/stella/tooling/commit/55c8622809b02eac3b527facacbecf53660474a6)]:
  - @stll/time@0.4.2

## 0.3.0

### Minor Changes

- [#194](https://github.com/stella/tooling/pull/194) [`26c494f`](https://github.com/stella/tooling/commit/26c494f29b3f5ca54c8f5e61285f16f9b607ece6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Hide inherited proxy variables while the network guard is installed, and add opt-in checked-in artifact regeneration.

## 0.2.0

### Minor Changes

- [#177](https://github.com/stella/tooling/pull/177) [`118453b`](https://github.com/stella/tooling/commit/118453bcd2827cdef80c2ddb04a4fda5afb4474f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add seeded randomness, fake timers, and a loopback fake HTTP server.

### Patch Changes

- [#185](https://github.com/stella/tooling/pull/185) [`fa51adb`](https://github.com/stella/tooling/commit/fa51adb978853052ad5d668bccb80ea558ee762c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Neutralize inherited process proxy variables while the network guard is installed.

## 0.1.1

### Patch Changes

- [#179](https://github.com/stella/tooling/pull/179) [`f1fffad`](https://github.com/stella/tooling/commit/f1fffadfbe1931e853776cf3005d25d4ef8e71f0) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish `@stll/test-kit` through the release workflow with provenance.
- Updated dependencies [[`f1fffad`](https://github.com/stella/tooling/commit/f1fffadfbe1931e853776cf3005d25d4ef8e71f0)]:
  - @stll/time@0.4.1

## 0.1.0

### Minor Changes

- [#147](https://github.com/stella/tooling/pull/147) [`5bee738`](https://github.com/stella/tooling/commit/5bee738d86a3cc154c5cefb835ee989cffd0cf79) Thanks [@jan-kubica](https://github.com/jan-kubica)! - First release: a controllable test clock, event-based waits, per-test temp
  directories, an outbound network guard (`@stll/test-kit/forbid-network`) and
  database-clock helpers (`@stll/test-kit/db`, with `drizzle-orm` as an optional
  peer dependency).

### Patch Changes

- Updated dependencies [[`5bee738`](https://github.com/stella/tooling/commit/5bee738d86a3cc154c5cefb835ee989cffd0cf79)]:
  - @stll/time@0.4.0
