# @stll/oxlint-config

## 1.2.4

### Patch Changes

- [#136](https://github.com/stella/tooling/pull/136) [`7d83a9d`](https://github.com/stella/tooling/commit/7d83a9d30deb76fd4a0c0b8210e5e0e5426bb7f9) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Give local package archive installs in the cloud setup a longer whole-call deadline, since their package scripts run in the same call.

## 1.2.3

### Patch Changes

- [#134](https://github.com/stella/tooling/pull/134) [`e68b544`](https://github.com/stella/tooling/commit/e68b5447f19c1d162e12102496870d9e87313bda) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep the cloud setup network deadline on package downloads only; package installation and configuration run offline afterwards.

## 1.2.2

### Patch Changes

- [#132](https://github.com/stella/tooling/pull/132) [`3805ff3`](https://github.com/stella/tooling/commit/3805ff3cc93cd9d59b24dafd50ab7d65c088000e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Toolchain change detection reads a setup wrapper action such as `setup-bun-cached` as the runtime its name starts with, so its `bun-version-file` selector is compared instead of the repository being reported as unreadable.

## 1.2.1

### Patch Changes

- [#130](https://github.com/stella/tooling/pull/130) [`3c2766b`](https://github.com/stella/tooling/commit/3c2766b2ecb638e9437f4f4324e98cbe394e04d1) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Toolchain change detection reads a setup version-file selector under a same-repository `actions/checkout` path, such as `base/package.json` after a checkout with `path: base`, as the repository's own tracked file, so the repository is compared instead of being reported as unreadable.

## 1.2.0

### Minor Changes

- [#124](https://github.com/stella/tooling/pull/124) [`9f0df31`](https://github.com/stella/tooling/commit/9f0df31da56dd2ff015aa592698827bba23bf603) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Resolve the generated Claude SessionStart hook through `$CLAUDE_PROJECT_DIR` so it
  runs from repository subdirectories; regeneration replaces the previous
  relative-path hook. Generated Claude settings set empty commit and pull request
  attribution, and `cloud-setup-drift` enforces both. Add GNU time (`/usr/bin/time`)
  from Ubuntu's `time` package as an optional cloud tool.

### Patch Changes

- [#125](https://github.com/stella/tooling/pull/125) [`290a4e7`](https://github.com/stella/tooling/commit/290a4e7b6db8768a5d74ae89f7024e7240f4f3ef) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Toolchain change detection reads Bun text lockfiles at version 2, which share the version 1 layout, so a repository with such a lockfile is compared instead of being reported as unreadable.

- [#129](https://github.com/stella/tooling/pull/129) [`a0261ca`](https://github.com/stella/tooling/commit/a0261cad827b6734bad5768293022da91beeb171) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Allow cloud setup to install dependencies without lifecycle scripts, skip the package index refresh only when an install downloads nothing, and log the duration of each setup phase.

- [#116](https://github.com/stella/tooling/pull/116) [`7b81321`](https://github.com/stella/tooling/commit/7b813219e9c01f88798cd70746c75ef40d5ff04c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Treat service image names as metadata when validating official Rust image versions.

## 1.1.0

### Minor Changes

- [#122](https://github.com/stella/tooling/pull/122) [`e86f590`](https://github.com/stella/tooling/commit/e86f590b25dcb78d992094144aa14a4768ab07de) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Provision pinned Rust toolchains and optional prebuilt cargo-nextest, wasm-bindgen,
  and uv tools in generated cloud setup scripts. Expose installed commands to fresh
  shells and merge a remote-only Claude SessionStart hook for cached environments.

  Bound network installation with explicit download, package-manager and dependency
  deadlines, and report the relevant hosts when a timeout occurs.

### Patch Changes

- [#118](https://github.com/stella/tooling/pull/118) [`1c72b07`](https://github.com/stella/tooling/commit/1c72b078bdcde7429249e0445c735539d5b67adf) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update runtime dependencies: acorn, picomatch, smol-toml, tsx, yaml.

## 1.0.2

### Patch Changes

- [#114](https://github.com/stella/tooling/pull/114) [`14e426c`](https://github.com/stella/tooling/commit/14e426cfc033e228a1d6ad2b45c79c2923185253) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Read tracked Git file lists without a subprocess output buffer limit in toolchain and publish-contract checks.

## 1.0.1

### Patch Changes

- [#106](https://github.com/stella/tooling/pull/106) [`1b15868`](https://github.com/stella/tooling/commit/1b15868d2e039c7916ee2c1aad70af86db770e99) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Require shared-pin Dependabot ignores to name the dependency and list major, minor, and patch version updates explicitly. Generate and validate this configuration while preserving security update pull requests.

## 1.0.0

### Major Changes

- [#98](https://github.com/stella/tooling/pull/98) [`4154cc5`](https://github.com/stella/tooling/commit/4154cc5f9b46795bc63ec9710047843fb763e524) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Pin Rust to 1.99.0 and enforce Rust selectors across commands, workflows and images. Replace the compiler-development toolchain field with one stable pin and validated, expiring consumer exceptions.

### Patch Changes

- [#98](https://github.com/stella/tooling/pull/98) [`4154cc5`](https://github.com/stella/tooling/commit/4154cc5f9b46795bc63ec9710047843fb763e524) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Check Rust selectors in brace groups, Docker commands and additional rustup commands. Preserve shell redirection semantics and inspect heredoc bodies as programs only for stdin-driven shells.

## 0.15.0

### Minor Changes

- [#92](https://github.com/stella/tooling/pull/92) [`4542d79`](https://github.com/stella/tooling/commit/4542d79809acbbcf5594e84d7a43ddd0de342107) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Make `library()` framework-neutral and add `react: { files: [...] }` to enable React and React Compiler rules only for consumer-selected files. Consumers upgrading from global React enforcement should explicitly select their React components and hooks.

  Breaking change for direct export users: `libraryRules` no longer contains React or React Compiler rules, and `libraryPlugins` no longer contains `react`. These exports are now framework-neutral. Migrate to `library({ react: { files: [...] } })`, or compose a file-scoped override with `plugins: [...libraryPlugins, "react"]` and `rules: { ...reactRules, ...consumerRules }`. Preserve any additional consumer plugins in that scoped list. No compatibility aliases are provided.

  Later consumer overrides that configure React rules must explicitly include the React plugin in their own file-scoped `plugins` list, because oxlint resolves each override against the framework-neutral base plugin list.

## 0.14.1

### Patch Changes

- [#81](https://github.com/stella/tooling/pull/81) [`b46475d`](https://github.com/stella/tooling/commit/b46475dbc61afb88628c8e9eb0548ad0aac5d5c7) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Check every packed JavaScript file against its declared syntax target and consumer Node. Add a guarded declaration-only Vite helper and recognize immutable Nuxt target markers across module formats.

## 0.14.0

### Minor Changes

- [#83](https://github.com/stella/tooling/pull/83) [`75193e8`](https://github.com/stella/tooling/commit/75193e893de562390ab70221c0c4db2309368b96) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a shared resolved-toolchain change detector, conditional compiler parity, and a reusable seeded typecheck probe.

## 0.13.0

### Minor Changes

- [#77](https://github.com/stella/tooling/pull/77) [`516e145`](https://github.com/stella/tooling/commit/516e145d7e175d5dc1f73ce4d87f3a0017a6ca15) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add published package contracts and isolated consumer artifact compatibility checks.

## 0.12.2

### Patch Changes

- [#80](https://github.com/stella/tooling/pull/80) [`6873cc9`](https://github.com/stella/tooling/commit/6873cc9cb58937d9db1f9933ed7506a47674b9ef) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Support scoped dynamic runtime selectors and current-source checkout refs.

## 0.12.1

### Patch Changes

- [#76](https://github.com/stella/tooling/pull/76) [`11a7ef7`](https://github.com/stella/tooling/commit/11a7ef7f8a5345694ec592b23223e1bad7cb781c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Scope generated environment files to cloud declarations with services.

- [#79](https://github.com/stella/tooling/pull/79) [`9efedf9`](https://github.com/stella/tooling/commit/9efedf93b3d1163febc7e6b47bf4c6e7fe8c3637) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Allow SHA256 image digests alongside exact runtime patch tags, matching tracked Node versions when present. Classify image families before checking unresolved tag variables.

## 0.12.0

### Minor Changes

- [#73](https://github.com/stella/tooling/pull/73) [`86b1db5`](https://github.com/stella/tooling/commit/86b1db538407233fc6ccb4b2b46007629e2ebd63) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Generate a shared cloud setup script from explicit repository declarations and pinned runtime/service policy. Add a CLI to write the script and a mandatory checker rule for missing, drifted, or undeclared scripts.

### Patch Changes

- [#74](https://github.com/stella/tooling/pull/74) [`b0b8e61`](https://github.com/stella/tooling/commit/b0b8e6147532e1015b07dc2e4521053a35231a87) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Validate workspace TypeScript compiler API dependencies against their repository install layout, derive JavaScript update roots from workspace and lockfile declarations, explain checkout selector provenance, and support scoped published-package Node engine-floor jobs.

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
