# @stll/test-kit

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
