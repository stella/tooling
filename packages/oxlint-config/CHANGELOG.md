# @stll/oxlint-config

## 0.11.0

### Minor Changes

- [#72](https://github.com/stella/tooling/pull/72) [`43e644b`](https://github.com/stella/tooling/commit/43e644b340aef0fb379d324fc312c62fe684e738) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add repeatable `--project` selection and `--help` to the typecheck parity CLI. Selected projects use the repository-root compiler installation without requiring a root tsconfig or discovering unselected project references.

- [#56](https://github.com/stella/tooling/pull/56) [`1e8c57a`](https://github.com/stella/tooling/commit/1e8c57aeea142fd5730d1d2bfc32954b34b14653) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Own shared tool and action pins in a versioned toolchain policy. Extend the tracked-file guard to check package catalogs, TypeScript layouts, runtime selectors, support ranges, action SHAs, and the shared Dependabot policy, with explicit reasoned repository opt-outs.

## 0.10.0

### Minor Changes

- [#62](https://github.com/stella/tooling/pull/62) [`1cf8d1e`](https://github.com/stella/tooling/commit/1cf8d1e1206fbc6d5ddbd1cd0e76824a48344f75) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Adopt oxlint and @oxlint/plugins 1.87.0, oxfmt 0.72.0, and
  oxlint-tsgolint 7.0.2003 in the shared toolchain.

## 0.9.1

### Patch Changes

- [#60](https://github.com/stella/tooling/pull/60) [`db89712`](https://github.com/stella/tooling/commit/db89712781025262f784ecccd08dc29aed882bbc) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Preserve rejected outFile options in temporary parity configs so TypeScript configuration errors remain visible. Expand real compiler regressions for output and build-info path combinations.

## 0.9.0

### Minor Changes

- [#58](https://github.com/stella/tooling/pull/58) [`3d2db6d`](https://github.com/stella/tooling/commit/3d2db6d40bdd9b82505981bb96f827c974c04810) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Ship stll-typecheck-parity to compare consumer repository diagnostics and seeded compiler-flag coverage, with timing and peak memory measurements.

### Patch Changes

- [#55](https://github.com/stella/tooling/pull/55) [`d2c40e8`](https://github.com/stella/tooling/commit/d2c40e83b9dc6378ef72fcc5535a68e70280c58d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Use Bun check for typechecking and guard diagnostic coverage against TypeScript.

- [#59](https://github.com/stella/tooling/pull/59) [`e598af1`](https://github.com/stella/tooling/commit/e598af1f0e146b2829a7911a3f5610f4688a5fe0) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Preserve omitted rootDir and outDir in typecheck-only parity projects so files outside the config directory retain the original diagnostics. Add real original-versus-temporary compiler regressions for default, output-directory, and composite configurations.

## 0.8.0

### Minor Changes

- [#54](https://github.com/stella/tooling/pull/54) [`674ff06`](https://github.com/stella/tooling/commit/674ff064a02a2620c86fd17b813ec9e2af4a456e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Move the shared toolchain policy to oxlint-config, pin Bun 1.4.3, and add the
  stll-toolchain-check command to detect divergent consumer pins.

## 0.7.0

### Minor Changes

- [#39](https://github.com/stella/tooling/pull/39) [`24ef000`](https://github.com/stella/tooling/commit/24ef000a5597d72325ff5c7abf8f9c044382b588) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Require Oxlint 1.80 or newer and replace the removed monolithic React Compiler rule with actionable category rules. Consumers that disabled `react/react-compiler` must replace it with precise category overrides.

  Publish Oxlint 1.81 as the current shared toolchain policy.

## 0.6.0

- Current published release. Earlier changes are recorded in the repository history.
