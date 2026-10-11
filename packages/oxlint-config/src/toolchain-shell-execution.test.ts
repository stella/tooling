/// <reference types="bun-types" />
import { expect, test } from "bun:test";

import { compilerCommandSegments } from "./toolchain-packages";
import { checkRuntimeFile } from "./toolchain-runtime";

const rust = "1.99.0";
const policy = {
  rust,
  bun: "1.4.3",
  node: "26.x",
  python: "3.13.7",
  packages: {},
  actions: {},
};
const check = (text: string) =>
  checkRuntimeFile({
    file: "scripts/check.sh",
    text,
    policy,
    trackedFiles: new Set<string>(),
    readFile: () => undefined,
  }).filter(({ rule }) => rule === "rust-version");

const programs = [
  (pin: string) => `cargo +${pin} test`,
  (pin: string) => `rustup default ${pin}`,
];

test("brace groups and functions retain executable Rust selector boundaries", () => {
  const groups = [
    (command: string) => `{ ${command}; }`,
    (command: string) => `check() { ${command}; }; check`,
    (command: string) => `function check { ${command}; }; check`,
    (command: string) => `{ { ${command}; }; }`,
    (command: string) => `check() {\n${command}\n}; check`,
  ];
  for (const program of programs) {
    for (const group of groups) {
      const positive = group(program(rust));
      const mutation = group(program("nightly"));
      expect(positive).not.toBe(mutation);
      expect(check(positive)).toEqual([]);
      expect(check(mutation)).toMatchObject([{ rule: "rust-version" }]);
    }
  }
});

test("heredoc programs run only when the receiving shell reads its program from stdin", () => {
  const shells = [
    "bash",
    "/bin/sh",
    "env RUST_LOG=info bash",
    "bash -s",
    "bash -se argument",
    "bash --noprofile -s argument",
    "echo ready; bash -s",
  ];
  for (const program of programs) {
    for (const shell of shells) {
      for (const delimiter of ["EOF", "'EOF'"]) {
        const source = (pin: string) =>
          `${shell} <<${delimiter}\n${program(pin)}\nEOF`;
        const positive = source(rust);
        const mutation = source("nightly");
        expect(positive).not.toBe(mutation);
        expect(check(positive)).toEqual([]);
        expect(check(mutation)).toMatchObject([{ rule: "rust-version" }]);
      }
    }
  }
});

test("script and command-string shells consume heredocs as data even with command text in them", () => {
  for (const shell of [
    "bash script.sh",
    "bash -- script.sh",
    "bash -c 'cat'",
    "bash -sc 'cat'",
    "bash -s -c 'cat'",
    "bash --rcfile config script.sh",
    "sh -c 'cat'",
  ]) {
    for (const delimiter of ["EOF", "'EOF'"]) {
      expect(
        check(`${shell} <<${delimiter}\ncargo +nightly test\nEOF`),
      ).toEqual([]);
    }
  }
  for (const argumentsAfterRedirect of [
    "script.sh",
    "-c 'cat'",
    "-s -c 'cat'",
  ]) {
    expect(
      check(`bash <<EOF ${argumentsAfterRedirect}\ncargo +nightly test\nEOF`),
    ).toEqual([]);
  }
});

test("data heredocs execute substitutions only when the delimiter permits expansion", () => {
  for (const shell of [
    "cat",
    "bash script.sh",
    "bash -c 'cat'",
    "bash -sc 'cat'",
  ]) {
    for (const substitute of [
      (command: string) => `$(${command})`,
      (command: string) => `\`${command}\``,
    ]) {
      const source = (pin: string) =>
        `${shell} <<EOF\n${substitute(`cargo +${pin} test`)}\nEOF`;
      expect(check(source(rust))).toEqual([]);
      expect(check(source("nightly"))).toMatchObject([
        { rule: "rust-version" },
      ]);
      expect(
        check(`${shell} <<'EOF'\n${substitute("cargo +nightly test")}\nEOF`),
      ).toEqual([]);
    }
  }
});

test("parameter braces stay literal tokens and compiler policy retains raw grouping", () => {
  expect(
    compilerCommandSegments(
      'echo ${RUSTUP_TOOLCHAIN}; echo "{ cargo +nightly test; }"',
    ),
  ).toContainEqual(["echo", "${RUSTUP_TOOLCHAIN}"]);
  expect(
    check('echo ${RUSTUP_TOOLCHAIN}; echo "{ cargo +nightly test; }"'),
  ).toEqual([]);
  const approved = "node ./node_modules/@typescript/native/bin/tsc --noEmit";
  expect(compilerCommandSegments(approved)).toContainEqual(approved.split(" "));
  for (const grouped of [`{ ${approved}; }`, `(${approved})`]) {
    expect(compilerCommandSegments(grouped)).not.toContainEqual(
      approved.split(" "),
    );
  }
});
