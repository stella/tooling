# @stll/oxlint-plugin

## 0.7.2

### Patch Changes

- [#275](https://github.com/stella/tooling/pull/275) [`b1d5fa2`](https://github.com/stella/tooling/commit/b1d5fa2a035ba8c5256a266bbb3252b0d1a599c5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update the shared lint and package-manager pins, add reviewed tsdown 0.23.7 and Vite 8.3.7 build adapters, and recognize tsdown's declaration-only option. Refresh the type-checker and Temporal runtime dependencies.

  Support checksum-pinned wasm-bindgen CLI 0.2.130 for matching Cargo workspaces.

## 0.7.1

### Patch Changes

- [#265](https://github.com/stella/tooling/pull/265) [`c655522`](https://github.com/stella/tooling/commit/c65552265257619469316394cc634cd15692cd35) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `library()` enables more bug-shaped rules outside oxlint's default correctness category: `eqeqeq` (with `== null` allowed), `no-var`, `prefer-const`, `no-case-declarations`, `default-case-last`, `array-callback-return`, `no-self-compare`, `no-unneeded-ternary`, `no-useless-concat`, `no-useless-constructor`, `preserve-caught-error`, `no-implied-eval`, `no-new-func`, `no-extend-native`, `no-proto`, TypeScript `ban-ts-comment`, `no-require-imports`, `no-empty-object-type`, `no-unsafe-function-type`, `no-unnecessary-type-constraint`, `no-confusing-non-null-assertion`, `no-deprecated`, `no-unnecessary-type-assertion`, `no-unnecessary-template-expression`, `no-unnecessary-boolean-literal-compare`, `restrict-plus-operands`, `no-unsafe-enum-comparison`, `no-mixed-enums`, `prefer-promise-reject-errors`, `use-unknown-in-catch-callback-variable`, `prefer-includes`, `prefer-string-starts-ends-with` and `prefer-find`, unicorn `prefer-node-protocol`, `prefer-array-flat-map`, `no-instanceof-builtins`, `no-accessor-recursion` and `require-post-message-target-origin`, `oxc/misrefactored-assign-op`, import `no-duplicates`, `no-self-import`, `no-absolute-path` and `no-empty-named-blocks`, and `promise/no-multiple-resolved`. Files selected with `react.files` now also get React's correctness rules (keys, duplicate props, state mutation, removed APIs), except `exhaustive-deps` and `jsx-no-undef`, which the compiler rules and TypeScript already cover.

  The test override now matches nested `__tests__/` and `__test__/` folders and `.mts`, `.cts`, `.mjs` and `.cjs` test files. Its globs were anchored at the config directory, so tests inside packages did not get it.

## 0.7.0

### Minor Changes

- [#234](https://github.com/stella/tooling/pull/234) [`5f47504`](https://github.com/stella/tooling/commit/5f475045cbbfc13080ff1f7c0c1e5c9e3190da81) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update the shared Oxlint and plugin SDK pin to 1.89.0 and tsgolint to 7.0.2005. Keep published peer floors aligned with the tested toolchain. The updates preserve lone surrogates in property names and fix circular-alias handling in no-deprecated.

## 0.6.4

### Patch Changes

- [#228](https://github.com/stella/tooling/pull/228) [`109a8fe`](https://github.com/stella/tooling/commit/109a8fe68520c267ff35f0186ae1b52cf575d9f9) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Point the `no-promise-matchers` message at `rejectionOf` from `@stll/test-kit`, and raise the `oxlint` and `@oxlint/plugins` peer floors to 1.87.0 to match the shared toolchain policy.

## 0.6.3

### Patch Changes

- [#221](https://github.com/stella/tooling/pull/221) [`55c8622`](https://github.com/stella/tooling/commit/55c8622809b02eac3b527facacbecf53660474a6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `@stll/typescript-config` no longer peers on `typescript`: `bun check` embeds the checker. The other packages emit declarations without a TypeScript install (oxc for `@stll/oxlint-plugin`, `@stll/time` and `@stll/test-kit`) and type check with `bun check --no-pretty --all --project=tsconfig.json`; their declared types are unchanged.

## 0.6.2

### Patch Changes

- [#217](https://github.com/stella/tooling/pull/217) [`8dd7c9b`](https://github.com/stella/tooling/commit/8dd7c9b6d6e998d1cc14767c286d6ac0eb851dcd) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `no-unsafe-inner-html` checks each branch of a conditional or logical `Object.assign` source instead of treating the whole expression as opaque, so `Object.assign(target, ready ? {} : { handler })` and a `null` or `undefined` branch pass while an HTML key or an opaque value in either branch is still reported.

## 0.6.1

### Patch Changes

- [#211](https://github.com/stella/tooling/pull/211) [`d0b519c`](https://github.com/stella/tooling/commit/d0b519cc3a46ae990070b6bfb88d150a09c88eaa) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `no-unsafe-inner-html` no longer treats `write` and `writeln` on the `stdin` of a child process as document sinks, when the receiver belongs to a const bound to `spawn`, `fork`, `exec` or `execFile` from `node:child_process` or to the global `Bun.spawn`. A never-reassigned class or function declaration is no longer a possible DOM target, so `Object.assign(Factory, source)` is not checked as an HTML sink. Instances of imported classes stay checked, because an import does not prove that a class is not a document.

## 0.6.0

### Minor Changes

- [#173](https://github.com/stella/tooling/pull/173) [`bfc0cfd`](https://github.com/stella/tooling/commit/bfc0cfd171b92b1ff4c6393a08e03ee2a56c62ab) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the bun-test-hygiene rules.

- [#174](https://github.com/stella/tooling/pull/174) [`79e0baf`](https://github.com/stella/tooling/commit/79e0baff5fdc33da6b63fbf1e9c280383f605867) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Extend HTML sink DOM provenance through expression wrappers, child collections, stable document aliases, and for-of bindings. Inspect literal React props spreads and namespaced HTML attributes through shared sink tables.

## 0.5.0

### Minor Changes

- [#193](https://github.com/stella/tooling/pull/193) [`1e0be5e`](https://github.com/stella/tooling/commit/1e0be5e6432583ec694ad3be7e3cdc29198d6bf9) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Report any assertion on measured wall-clock time and any timer race, with no exemptions. Test ordering with a controlled clock or deferred.

## 0.4.0

### Minor Changes

- [#180](https://github.com/stella/tooling/pull/180) [`abcffe0`](https://github.com/stella/tooling/commit/abcffe099bf79f3ac85219772eac8f313683cd9f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add test reliability rules for test files: `no-wall-clock-in-tests`, `no-real-timer-waits-in-tests`, `no-unseeded-random-in-tests`, `no-real-network-in-tests` and `no-checkout-writes-in-tests`. Each points to the matching `@stll/test-kit` primitive. They are exported but not enabled by any preset.

## 0.3.0

### Minor Changes

- [#161](https://github.com/stella/tooling/pull/161) [`8cc7be4`](https://github.com/stella/tooling/commit/8cc7be4b1c721fdf7edddd64630ea95cd7b0cf79) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Extend shared HTML-sink and colocated-route prefetch coverage.

## 0.2.2

### Patch Changes

- [#62](https://github.com/stella/tooling/pull/62) [`1cf8d1e`](https://github.com/stella/tooling/commit/1cf8d1e1206fbc6d5ddbd1cd0e76824a48344f75) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Adopt oxlint and @oxlint/plugins 1.87.0, oxfmt 0.72.0, and
  oxlint-tsgolint 7.0.2003 in the shared toolchain.

## 0.2.1

### Patch Changes

- [#55](https://github.com/stella/tooling/pull/55) [`d2c40e8`](https://github.com/stella/tooling/commit/d2c40e83b9dc6378ef72fcc5535a68e70280c58d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Use Bun check for typechecking and guard diagnostic coverage against TypeScript.

## 0.2.0

### Minor Changes

- [#36](https://github.com/stella/tooling/pull/36) [`65497ef`](https://github.com/stella/tooling/commit/65497efd68b09002b78cebe167cfaaf0fe2bdbf6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish route-query guard plugins for TanStack Router + React Query consumers.
  The guards reject raw route query-client calls and suspense queries that start
  only after route component mount, preventing avoidable request waterfalls.

## 0.1.0

### Minor Changes

- [#23](https://github.com/stella/tooling/pull/23) [`1598cb2`](https://github.com/stella/tooling/commit/1598cb277a8717740a31ac38c08e255c655549a9) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish portable Oxlint rules for unsafe casts, incomplete union-keyed records, and unsanitized DOM HTML sinks.
