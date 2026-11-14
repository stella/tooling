# @stll/time

## 0.4.3

### Patch Changes

- [#275](https://github.com/stella/tooling/pull/275) [`b1d5fa2`](https://github.com/stella/tooling/commit/b1d5fa2a035ba8c5256a266bbb3252b0d1a599c5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update the shared lint and package-manager pins, add reviewed tsdown 0.23.7 and Vite 8.3.7 build adapters, and recognize tsdown's declaration-only option. Refresh the type-checker and Temporal runtime dependencies.

  Support checksum-pinned wasm-bindgen CLI 0.2.130 for matching Cargo workspaces.

- [#270](https://github.com/stella/tooling/pull/270) [`4f6bd91`](https://github.com/stella/tooling/commit/4f6bd9190d010c36074b608986fd97f04a47585e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `@stll/oxlint-config` moves to tsrs 0.21.0 and semver 7.8.6, and its publish target resolver supports tsdown 0.23.5. `@stll/time` moves to temporal-polyfill 1.0.7.

## 0.4.2

### Patch Changes

- [#221](https://github.com/stella/tooling/pull/221) [`55c8622`](https://github.com/stella/tooling/commit/55c8622809b02eac3b527facacbecf53660474a6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `@stll/typescript-config` no longer peers on `typescript`: `bun check` embeds the checker. The other packages emit declarations without a TypeScript install (oxc for `@stll/oxlint-plugin`, `@stll/time` and `@stll/test-kit`) and type check with `bun check --no-pretty --all --project=tsconfig.json`; their declared types are unchanged.

## 0.4.1

### Patch Changes

- [#179](https://github.com/stella/tooling/pull/179) [`f1fffad`](https://github.com/stella/tooling/commit/f1fffadfbe1931e853776cf3005d25d4ef8e71f0) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Release the current `@stll/time` sources through the release workflow.

## 0.4.0

### Minor Changes

- [#147](https://github.com/stella/tooling/pull/147) [`5bee738`](https://github.com/stella/tooling/commit/5bee738d86a3cc154c5cefb835ee989cffd0cf79) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish `@stll/time` from this repository with ESM and CommonJS builds.

## 0.3.0

### Minor Changes

- [#4760](https://github.com/stella/stella/pull/4760) [`c17c9b8`](https://github.com/stella/stella/commit/c17c9b88822a27615a99baa589dd54d66ef4b666) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `parseTimeZoneId(value)` and the `TimeZoneId` brand: an IANA time-zone id read the way the runtime's tz database spells it; fixed UTC offsets are refused.

### Patch Changes

- [#4834](https://github.com/stella/stella/pull/4834) [`9a1473c`](https://github.com/stella/stella/commit/9a1473cba3f3440878fc7bdc9a5c74b148705428) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Importing `@stll/time` no longer calls `Temporal` at module load, so it loads where the runtime's `Temporal` is partial.

## 0.2.0

### Minor Changes

- [#4724](https://github.com/stella/stella/pull/4724) [`6a78bd5`](https://github.com/stella/stella/commit/6a78bd510e807883521924bbaf38afe2be5e84f3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `todayFor(zone, at?)`, the calendar day a person in an IANA time zone sees at an instant.

## 0.1.0

### Minor Changes

- [#4034](https://github.com/stella/stella/pull/4034) [`ed157f2`](https://github.com/stella/stella/commit/ed157f2f2f445bdda2575f6cc51ecf922be5057f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - First release.
