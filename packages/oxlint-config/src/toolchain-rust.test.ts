/// <reference types="bun-types" />
import { expect, test } from "bun:test";

import { parseToolchainConfiguration } from "./toolchain-guard";
import { toolchainInputKind } from "./toolchain-inputs";
import { checkRuntimeFile } from "./toolchain-runtime";
import { parseRustExceptions } from "./toolchain-rust";

const rust = "1.99.0";
const sha = "a".repeat(40);
const policy = {
  rust,
  bun: "1.4.3",
  node: "26.x",
  python: "3.13.7",
  packages: {},
  actions: { "dtolnay/rust-toolchain": { sha, version: "v1" } },
};
const check = (
  file: string,
  text: string,
  exceptions = parseRustExceptions(undefined),
) =>
  checkRuntimeFile({
    file,
    text,
    policy,
    rustExceptions: exceptions,
    trackedFiles: new Set<string>(),
    readFile: () => undefined,
  }).filter(({ rule }) => rule === "rust-version");
const workflow = (body: string) => `jobs:\n  test:\n${body}`;
const fixtures = [
  {
    file: ".github/workflows/ci.yml",
    source: (pin: string) =>
      workflow(
        `    steps:\n      - uses: dtolnay/rust-toolchain@${sha}\n        with: {toolchain: '${pin}'}`,
      ),
  },
  {
    file: ".github/actions/rust/action.yml",
    source: (pin: string) =>
      `runs:\n  using: composite\n  steps:\n    - uses: dtolnay/rust-toolchain@${sha}\n      with: {toolchain: '${pin}'}`,
  },
  {
    file: ".github/workflows/ci.yml",
    source: (pin: string) => workflow(`    env: {RUSTUP_TOOLCHAIN: '${pin}'}`),
  },
  {
    file: ".github/workflows/ci.yml",
    source: (pin: string) =>
      workflow(`    steps:\n      - run: cargo +${pin} test`),
  },
  {
    file: "package.json",
    source: (pin: string) =>
      JSON.stringify({ scripts: { lint: `cargo +${pin} hawk` } }),
  },
  {
    file: "scripts/rust.sh",
    source: (pin: string) =>
      `#!/bin/sh\nexport RUSTUP_TOOLCHAIN='${pin}'\ncargo +${pin} test\nrustup toolchain install ${pin}\nrustup default ${pin}`,
  },
  {
    file: ".github/workflows/ci.yml",
    source: (pin: string) =>
      workflow(`    steps:\n      - run: rustup toolchain install ${pin}`),
  },
  {
    file: ".github/workflows/ci.yml",
    source: (pin: string) =>
      workflow(`    steps:\n      - run: rustup default ${pin}`),
  },
  ...["rust-toolchain", "toolchain"].map((input) => ({
    file: ".github/workflows/ci.yml",
    source: (pin: string) =>
      workflow(
        `    uses: stella/.github/.github/workflows/rust.yml@${sha}\n    with: {${input}: '${pin}'}`,
      ),
  })),
  {
    file: ".github/workflows/rust.yml",
    source: (pin: string) =>
      `on:\n  workflow_call:\n    inputs:\n      rust-toolchain:\n        type: string\n        default: '${pin}'`,
  },
  {
    file: "Dockerfile",
    source: (pin: string) => `FROM rust:${pin}-bookworm AS build`,
  },
  {
    file: ".github/workflows/ci.yml",
    source: (pin: string) => workflow(`    container: rust:${pin}`),
  },
  {
    file: "scripts/ci-service-images.json",
    source: (pin: string) => JSON.stringify({ rust: { image: `rust:${pin}` } }),
  },
];

test("every executable Rust selector rejects off-pin mutations", () => {
  for (const { file, source } of fixtures) {
    expect(toolchainInputKind(file)).toBe("config");
    expect(check(file, source(rust))).toEqual([]);
    for (const mutation of ["1.97.1", "stable", "nightly", "${RUST_VERSION}"]) {
      expect(source(mutation)).not.toBe(source(rust));
      expect(check(file, source(mutation)).length).toBeGreaterThan(0);
    }
  }
});

test("the Rust action's omitted toolchain and untagged images float", () => {
  expect(
    check(
      ".github/workflows/ci.yml",
      workflow(`    steps:\n      - uses: dtolnay/rust-toolchain@${sha}`),
    ),
  ).toHaveLength(1);
  expect(check("Dockerfile", "FROM rust")).toHaveLength(1);
  expect(
    check("scripts/ci-service-images.json", '{"rust":"rust"}'),
  ).toHaveLength(1);
});

test("non-Rust action toolchain inputs and shell comments are outside the contract", () => {
  expect(
    check(
      ".github/workflows/ci.yml",
      workflow(
        `    steps:\n      - uses: vendor/setup-java@${sha}\n        with: {toolchain: temurin}`,
      ),
    ),
  ).toEqual([]);
  expect(
    check(
      "scripts/rust.sh",
      "# cargo +nightly test\n# RUSTUP_TOOLCHAIN=stable",
    ),
  ).toEqual([]);
});

const exception = {
  pin: "1.97.1",
  reason: "Awaiting upstream compiler support",
  tracking: "https://github.com/stella/tooling/issues/123",
  expires: "2099-01-01",
};
test("one exact release exception authorizes every selector without floating channels", () => {
  const exceptions = parseRustExceptions([exception], "2026-10-11");
  for (const { file, source } of fixtures) {
    expect(check(file, source(exception.pin), exceptions)).toEqual([]);
    expect(check(file, source("1.97.2"), exceptions).length).toBeGreaterThan(0);
    expect(check(file, source("stable"), exceptions).length).toBeGreaterThan(0);
  }
  expect(
    parseToolchainConfiguration({ rustExceptions: [exception] }).rustExceptions,
  ).toEqual([exception]);
  expect(() =>
    parseToolchainConfiguration({
      optOuts: [{ rule: "rust-version", reason: "skip" }],
    }),
  ).toThrow("rust-version requires expiring");
});

test("Rust exception records are closed, unique, tracked and expire strictly", () => {
  for (const invalid of [
    { ...exception, pin: "stable" },
    { ...exception, pin: "nightly-2026-04-16" },
    { ...exception, pin: "01.97.1" },
    { ...exception, reason: " " },
    { ...exception, tracking: "later" },
    { ...exception, expires: "2026-10-11" },
    { ...exception, expires: "2026-10-10" },
    { ...exception, expires: "2099-02-30" },
    { ...exception, expires: "never" },
    { ...exception, extra: true },
    {
      pin: exception.pin,
      reason: exception.reason,
      expires: exception.expires,
    },
  ])
    expect(() => parseRustExceptions([invalid], "2026-10-11")).toThrow(
      "each Rust exception requires",
    );
  expect(() =>
    parseRustExceptions([exception, exception], "2026-10-11"),
  ).toThrow("each Rust exception requires");
  expect(() => parseRustExceptions(true)).toThrow(
    "rustExceptions must be an array",
  );
  expect(parseRustExceptions(undefined)).toEqual([]);
});

test("shell selection follows quotes, options, continuations and command boundaries", () => {
  const valid = `echo 'cargo +stable test' # rustup default stable\nrustup toolchain install --profile minimal --component rustfmt ${rust}\ncargo \\\n+${rust} test\nRUSTUP_TOOLCHAIN='${rust}' cargo +${rust} test`;
  expect(check("scripts/rust.sh", valid)).toEqual([]);
  expect(
    check("scripts/rust.sh", valid.replace(`+${rust} test`, "+stable test")),
  ).toHaveLength(1);
  expect(
    check(
      "scripts/rust.sh",
      `rustup toolchain install --profile minimal ${rust} stable`,
    ),
  ).toHaveLength(1);
});

test("shared shell boundaries retain substitutions and exclude literal heredoc bodies", () => {
  expect(
    check(
      "scripts/rust.sh",
      "cat <<'TEXT'\ncargo +nightly test\nRUSTUP_TOOLCHAIN=nightly\nTEXT\necho 'cargo +nightly test'",
    ),
  ).toEqual([]);
  expect(check("scripts/rust.sh", `env -u OLD cargo +${rust} test`)).toEqual(
    [],
  );
  expect(
    check("scripts/rust.sh", "env -u OLD cargo +nightly test"),
  ).toHaveLength(1);
  expect(
    check("scripts/rust.sh", 'OUTPUT="$(cargo +nightly test)"'),
  ).toHaveLength(1);
  expect(check("scripts/rust.sh", "rustup toolchain install")).toHaveLength(1);
});

test("shell data cannot hide executable substitutions or turn comments into selectors", () => {
  expect(
    check(
      "scripts/rust.sh",
      "cat << TEXT\ncargo +nightly test\nTEXT\n# $(cargo +nightly test)\necho done # $(cargo +nightly test)",
    ),
  ).toEqual([]);
  expect(
    check("scripts/rust.sh", "cat <<TEXT\n$(cargo +nightly test)\nTEXT"),
  ).toHaveLength(1);
  expect(
    check("scripts/rust.sh", "cat <<'TEXT'\n$(cargo +nightly test)\nTEXT"),
  ).toEqual([]);
});

test("shell heredoc command input executes even when its delimiter is quoted", () => {
  expect(
    check("scripts/rust.sh", "bash <<'SCRIPT'\ncargo +nightly test\nSCRIPT"),
  ).toHaveLength(1);
  expect(
    check("scripts/rust.sh", `bash <<'SCRIPT'\ncargo +${rust} test\nSCRIPT`),
  ).toEqual([]);
  expect(
    check("scripts/rust.sh", "rustup toolchain install --profile minimal"),
  ).toHaveLength(1);
});

test("environment assignments are checked only where shell execution sets them", () => {
  expect(check("scripts/rust.sh", "echo 'RUSTUP_TOOLCHAIN=nightly'")).toEqual(
    [],
  );
  for (const prefix of ["", "export ", "readonly ", "env "]) {
    expect(
      check("scripts/rust.sh", `${prefix}RUSTUP_TOOLCHAIN=${rust}`),
    ).toEqual([]);
    expect(
      check("scripts/rust.sh", `${prefix}RUSTUP_TOOLCHAIN=nightly`),
    ).toHaveLength(1);
  }
});
