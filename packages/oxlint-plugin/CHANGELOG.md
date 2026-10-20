# @stll/oxlint-plugin

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
