/// <reference types="bun-types" />
import { expect, test } from "bun:test";

import {
  compilerCommandSegments,
  shellCommandSegments,
} from "./toolchain-packages";
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
    "env -C /tmp bash",
    "env --chdir /tmp bash",
    "env --chdir=/tmp bash",
    "env -C/tmp bash",
    "env -S 'bash -s'",
    "env --split-string='bash -s'",
    "env -C /tmp -S 'bash -s'",
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
  const approved = "bun check --no-pretty --all --project=tsconfig.json";
  expect(compilerCommandSegments(approved)).toContainEqual(approved.split(" "));
  for (const grouped of [`{ ${approved}; }`, `(${approved})`]) {
    expect(compilerCommandSegments(grouped)).not.toContainEqual(
      approved.split(" "),
    );
  }
});

test("redirection destinations and descriptor duplication are not Rust toolchain arguments", () => {
  const redirectedPrograms = [
    (pin: string) => `cargo +${pin} test`,
    (pin: string) => `rustup toolchain install ${pin}`,
    (pin: string) => `rustup default ${pin}`,
  ];
  const redirects = [
    ">/dev/null",
    "> /dev/null",
    "2>/dev/null",
    "2> /dev/null",
    "2>&1",
    "2>& 1",
    "<file",
    "< file",
    ">/dev/null 2>&1 <file",
    "2>/dev/null >> output.log",
    "&>/dev/null",
    "2>&-",
    "<&0",
  ];
  for (const program of redirectedPrograms)
    for (const redirect of redirects) {
      const positive = `${program(rust)} ${redirect}`;
      const mutation = `${program("nightly")} ${redirect}`;
      expect(positive).not.toBe(mutation);
      expect(check(positive)).toEqual([]);
      expect(check(mutation)).toMatchObject([{ rule: "rust-version" }]);
    }
  expect(check(`<file rustup default ${rust} >/dev/null 2>&1`)).toEqual([]);
  expect(check("<file rustup default nightly >/dev/null 2>&1")).toMatchObject([
    { rule: "rust-version" },
  ]);
  expect(
    check(
      `cargo +${rust} test >/dev/null 2>&1 && rustup default ${rust} <file`,
    ),
  ).toEqual([]);
  expect(
    check(
      `cargo +${rust} test >/dev/null 2>&1 && rustup default nightly <file`,
    ),
  ).toMatchObject([{ rule: "rust-version" }]);
  expect(check(`bash 2>&1 -c 'rustup default ${rust} >/dev/null'`)).toEqual([]);
  expect(
    check("bash 2>&1 -c 'rustup default nightly >/dev/null'"),
  ).toMatchObject([{ rule: "rust-version" }]);
});

test("quoted and escaped redirection-shaped arguments stay literal words", () => {
  const source = String.raw`echo '<file' '>' \> \<file`;
  expect(shellCommandSegments(source)).toContainEqual([
    "echo",
    "'<file'",
    "'>'",
    "\\>",
    "\\<file",
  ]);
  expect(check(`cargo +${rust} test '<file' '>'`)).toEqual([]);
  expect(check("cargo +nightly test '<file' '>'")).toMatchObject([
    { rule: "rust-version" },
  ]);
  expect(check("echo 'rustup default nightly >file'")).toEqual([]);
});

test("redirection target substitutions retain executable Rust selectors", () => {
  for (const target of [
    (pin: string) => `$(cargo +${pin} test)`,
    (pin: string) => `"$(rustup default ${pin})"`,
    (pin: string) => `\`cargo +${pin} test\``,
    (pin: string) => `$(echo $(rustup default ${pin}))`,
  ]) {
    expect(check(`rustup default ${rust} >${target(rust)}`)).toEqual([]);
    expect(
      check(`rustup default ${rust} >${target("nightly")}`).length,
    ).toBeGreaterThan(0);
  }
  expect(check(`rustup default ${rust} >'$(cargo +nightly test)'`)).toEqual([]);
});

test("heredoc receiver classification survives other redirections", () => {
  for (const receiver of [
    "bash >/dev/null",
    "bash 2>&1 -s",
    "env CHECK=1 bash <input >output",
  ]) {
    expect(check(`${receiver} <<'EOF'\ncargo +${rust} test\nEOF`)).toEqual([]);
    expect(
      check(`${receiver} <<'EOF'\ncargo +nightly test\nEOF`),
    ).toMatchObject([{ rule: "rust-version" }]);
  }
  for (const header of ["bash 2>/dev/null <<EOF", "bash <<EOF >out"]) {
    expect(check(`${header}\ncargo +${rust} test\nEOF`)).toEqual([]);
    expect(check(`${header}\ncargo +nightly test\nEOF`)).toMatchObject([
      { rule: "rust-version" },
    ]);
  }
  expect(check("cat >/dev/null <<'EOF'\ncargo +nightly test\nEOF")).toEqual([]);
});

test("brace-shaped echo arguments stay data while command-position groups execute", () => {
  for (const command of [
    (pin: string) => `cargo +${pin} test`,
    (pin: string) => `rustup default ${pin}`,
  ]) {
    expect(check(`echo { ${command("nightly")} }`)).toEqual([]);
    expect(
      shellCommandSegments(`echo { ${command("nightly")} }`),
    ).toContainEqual(["echo", "{", ...command("nightly").split(" "), "}"]);
    for (const group of [
      (program: string) => `{ ${program}; }`,
      (program: string) => `check() { ${program}; }; check`,
      (program: string) => `function check { ${program}; }; check`,
      (program: string) => `if { ${program}; }; then echo ok; fi`,
    ]) {
      expect(check(group(command(rust)))).toEqual([]);
      expect(check(group(command("nightly")))).toMatchObject([
        { rule: "rust-version" },
      ]);
    }
  }
});

test("trailing heredoc comments end the receiver invocation", () => {
  for (const receiver of ["bash", "bash -s", "bash >/dev/null 2>&1"])
    for (const delimiter of ["EOF", "'EOF'"]) {
      const source = (pin: string) =>
        `${receiver} <<${delimiter} # receiver comment\ncargo +${pin} test\nEOF`;
      expect(source(rust)).not.toBe(source("nightly"));
      expect(check(source(rust))).toEqual([]);
      expect(check(source("nightly"))).toMatchObject([
        { rule: "rust-version" },
      ]);
    }
  expect(check("cat <<EOF # data comment\ncargo +nightly test\nEOF")).toEqual(
    [],
  );
});

test("only the effective stdin heredoc is a shell program", () => {
  const dataHeaders = [
    "bash 3<<'DATA' </dev/null",
    "bash <<'DATA' </dev/null",
    "bash <<'DATA' <script.sh",
    "bash <<'DATA' 0<&1",
    "bash <<'DATA' 0<&-",
  ];
  for (const header of dataHeaders) {
    expect(check(`${header}\ncargo +${rust} test\nDATA`)).toEqual([]);
    expect(check(`${header}\ncargo +nightly test\nDATA`)).toEqual([]);
  }
  for (const header of ["bash </dev/null <<'DATA'", "bash 0<<'DATA'"]) {
    expect(check(`${header}\ncargo +${rust} test\nDATA`)).toEqual([]);
    expect(check(`${header}\ncargo +nightly test\nDATA`)).toMatchObject([
      { rule: "rust-version" },
    ]);
  }
});

test("multiple stdin heredocs check the last effective program rather than earlier data", () => {
  const source = (first: string, last: string) =>
    `bash <<'FIRST' <<'LAST'\ncargo +${first} test\nFIRST\nrustup default ${last}\nLAST`;
  expect(check(source("nightly", rust))).toEqual([]);
  expect(check(source(rust, rust))).toEqual([]);
  expect(check(source("nightly", "nightly"))).toMatchObject([
    { rule: "rust-version" },
  ]);
  expect(check(source(rust, "nightly"))).toMatchObject([
    { rule: "rust-version" },
  ]);
});

test("descriptor copies route heredocs to stdin in redirection order", () => {
  for (const header of [
    "bash 3<<'DATA' 0<&3",
    "bash 3<<'DATA' </dev/null 0<&3",
    "bash 3<<'DATA' 0<&3 3<&-",
    "bash 3<<'DATA' 0<&3-",
  ]) {
    expect(check(`${header}\ncargo +${rust} test\nDATA`)).toEqual([]);
    expect(check(`${header}\ncargo +nightly test\nDATA`)).toMatchObject([
      { rule: "rust-version" },
    ]);
  }
  expect(
    check("bash 3<<'DATA' 0<&3 </dev/null\ncargo +nightly test\nDATA"),
  ).toEqual([]);
  const restored = (pin: string) =>
    `bash <<'FIRST' 3<&0 <<'LAST' 0<&3\ncargo +${pin} test\nFIRST\ncargo +nightly test\nLAST`;
  expect(check(restored(rust))).toEqual([]);
  expect(check(restored("nightly"))).toMatchObject([{ rule: "rust-version" }]);
});
