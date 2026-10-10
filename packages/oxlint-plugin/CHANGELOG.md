# @stll/oxlint-plugin

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
