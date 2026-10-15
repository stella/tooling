/// <reference types="bun-types" />
import { expect, test } from "bun:test";

import { parseToolchainConfiguration } from "./toolchain-guard";
import { ownedDockerImageAliases } from "./toolchain-images";
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

test("subshells and substitutions cannot hide Rust selectors", () => {
  const commands = [
    (pin: string) => `(cargo +${pin} test)`,
    (pin: string) => `(rustup default ${pin})`,
    (pin: string) => `echo $(cargo +${pin} test)`,
    (pin: string) => `echo $(rustup default ${pin})`,
    (pin: string) => `echo \`cargo +${pin} test\``,
    (pin: string) => `echo \`rustup default ${pin}\``,
  ];
  for (const command of commands) {
    expect(check("scripts/rust.sh", command(rust))).toEqual([]);
    expect(command("nightly")).not.toBe(command(rust));
    expect(check("scripts/rust.sh", command("nightly")).length).toBeGreaterThan(
      0,
    );
  }
});

test("rustup run and override set require an exact selected release", () => {
  for (const command of [
    (pin: string) => `rustup run ${pin} cargo test`,
    (pin: string) => `rustup run --install ${pin} cargo test`,
    (pin: string) => `rustup override set ${pin}`,
    (pin: string) => `rustup override set --path ./crate ${pin}`,
  ]) {
    expect(check("scripts/rust.sh", command(rust))).toEqual([]);
    expect(check("scripts/rust.sh", command("stable"))).toHaveLength(1);
    expect(check("scripts/rust.sh", command("1.97.1"))).toHaveLength(1);
  }
  for (const command of [
    "rustup run",
    "rustup override set",
    "rustup override set --path ./crate",
  ])
    expect(check("scripts/rust.sh", command)).toHaveLength(1);
});

test("executable shell command arguments expose nested Rust selectors", () => {
  const quote = (source: string) => `'${source.replaceAll("'", "'\\''")}'`;
  const commands = [
    (pin: string) => `cargo +${pin} test`,
    (pin: string) => `rustup default ${pin}`,
    (pin: string) => `rustup run ${pin} cargo test`,
  ];
  const launchers = [
    (source: string) => `bash -c ${quote(source)}`,
    (source: string) => `sh -c ${quote(source)}`,
    (source: string) => `bash -lc ${quote(source)}`,
    (source: string) => `/bin/bash --noprofile --norc -eu -c ${quote(source)}`,
    (source: string) => `bash -o errexit -O extglob -lc ${quote(source)}`,
    (source: string) => `env -u OLD_FLAG CHECK=1 bash -c ${quote(source)}`,
    (source: string) => `bash -c ${quote(`sh -c ${quote(source)}`)}`,
  ];
  for (const command of commands)
    for (const launch of launchers) {
      expect(check("scripts/rust.sh", launch(command(rust)))).toEqual([]);
      expect(launch(command("nightly"))).not.toBe(launch(command(rust)));
      expect(
        check("scripts/rust.sh", launch(command("nightly"))).length,
      ).toBeGreaterThan(0);
    }
  expect(check("scripts/rust.sh", `bash -c "cargo +${rust} test"`)).toEqual([]);
  expect(
    check("scripts/rust.sh", 'bash -c "cargo +nightly test"'),
  ).toHaveLength(1);
});

test("literal shell command examples remain data at every nesting level", () => {
  for (const source of [
    `echo 'bash -c "cargo +nightly test"'`,
    `printf '%s\\n' 'sh -c "rustup run nightly cargo test"'`,
    `bash -c 'echo "cargo +nightly test"'`,
    `bash -lc 'printf "%s\\n" "rustup run nightly cargo test"'`,
    `cat <<'TEXT'\nbash -c 'cargo +nightly test'\nTEXT`,
  ])
    expect(check("scripts/rust.sh", source)).toEqual([]);
});

test("Rust setup actions require explicit exact selectors across toolchain lists", () => {
  const action = `actions-rust-lang/setup-rust-toolchain@${sha}`;
  const setup = (pin?: string) =>
    workflow(
      `    steps:\n      - uses: ${action}${pin === undefined ? "" : `\n        with: {toolchain: '${pin}'}`}`,
    );
  expect(check(".github/workflows/ci.yml", setup(rust))).toEqual([]);
  expect(check(".github/workflows/ci.yml", setup(`${rust}, ${rust}`))).toEqual(
    [],
  );
  for (const pin of ["nightly", undefined, `${rust}, nightly`])
    expect(
      check(".github/workflows/ci.yml", setup(pin)).length,
    ).toBeGreaterThan(0);
});

test("both Rust slim tag orderings retain exact pins on every image surface", () => {
  const digest = `@sha256:${"a".repeat(64)}`;
  const surfaces = [
    { file: "Dockerfile", source: (image: string) => `FROM ${image}` },
    {
      file: ".github/workflows/ci.yml",
      source: (image: string) => workflow(`    container: '${image}'`),
    },
    {
      file: "scripts/ci-service-images.json",
      source: (image: string) => JSON.stringify({ rust: { image } }),
    },
  ];
  for (const suffix of [
    "-slim-bookworm",
    "-slim-trixie",
    "-bookworm-slim",
    "-trixie-slim",
  ])
    for (const hash of ["", digest])
      for (const { file, source } of surfaces) {
        expect(check(file, source(`rust:${rust}${suffix}${hash}`))).toEqual([]);
        for (const mutation of ["1.97.1", `${rust}-rc.1`, "nightly"])
          expect(
            check(file, source(`rust:${mutation}${suffix}${hash}`)).length,
          ).toBeGreaterThan(0);
      }
});

test("service image names are metadata and rustfs is not an official Rust image", () => {
  const inventory = (image: string) =>
    JSON.stringify([
      { source: "docker.io/rustfs/rustfs:1.0.0", name: "rustfs" },
      { source: image, name: "rust" },
    ]);
  for (const repository of ownedDockerImageAliases(["rust"])) {
    expect(
      check(
        "scripts/ci-service-images.json",
        inventory(`${repository}:${rust}`),
      ),
    ).toEqual([]);
    for (const tag of ["nightly", "1.97.1", "latest"]) {
      expect(
        check(
          "scripts/ci-service-images.json",
          inventory(`${repository}:${tag}`),
        ),
      ).toHaveLength(1);
    }
    expect(
      check("scripts/ci-service-images.json", inventory(repository)),
    ).toHaveLength(1);
  }
  for (const image of [
    "rustfs",
    "rustfs:1.0.0",
    "docker.io/rustfs/rustfs:1.0.0",
  ]) {
    expect(check("scripts/ci-service-images.json", inventory(image))).toEqual(
      [],
    );
  }
});

test("rustup update and install spellings validate every explicit release", () => {
  for (const command of [
    "rustup update",
    "rustup toolchain update",
    "rustup install",
    "rustup add",
    "rustup toolchain install",
  ]) {
    expect(check("scripts/rust.sh", `${command} ${rust}`)).toEqual([]);
    expect(
      check("scripts/rust.sh", `${command} --profile minimal ${rust}`),
    ).toEqual([]);
    for (const mutation of ["nightly", "stable", "1.97.1", "''"]) {
      expect(`${command} ${mutation}`).not.toBe(`${command} ${rust}`);
      expect(check("scripts/rust.sh", `${command} ${mutation}`)).toHaveLength(
        1,
      );
    }
    expect(check("scripts/rust.sh", `${command} ${rust} nightly`)).toHaveLength(
      1,
    );
  }
  expect(check("scripts/rust.sh", "rustup update")).toEqual([]);
  expect(check("scripts/rust.sh", "rustup toolchain update")).toEqual([]);
});

test("rustup global options and selected toolchains preserve subcommand validation", () => {
  for (const prefix of [
    "--quiet",
    "-v",
    `--quiet +${rust}`,
    `+${rust}`,
    "--",
  ]) {
    for (const command of [
      "component add rustfmt --toolchain",
      "target add wasm32-unknown-unknown --toolchain",
      "add",
      "toolchain add",
      "default",
    ]) {
      const positive = `rustup ${prefix} ${command} ${rust}`;
      const mutation = `rustup ${prefix} ${command} nightly`;
      expect(positive).not.toBe(mutation);
      expect(check("scripts/rust.sh", positive)).toEqual([]);
      expect(check("scripts/rust.sh", mutation)).toHaveLength(1);
    }
  }
  expect(check("scripts/rust.sh", `rustup --quiet +${rust} show`)).toEqual([]);
  expect(check("scripts/rust.sh", "rustup --quiet +nightly show")).toHaveLength(
    1,
  );
});

test("rustup target and component options select exact releases while defaults remain valid", () => {
  const commands = [
    "rustup target add wasm32-unknown-unknown",
    "rustup component add rustfmt",
  ];
  const surfaces = [
    { file: "scripts/rust.sh", source: (command: string) => command },
    {
      file: "package.json",
      source: (command: string) =>
        JSON.stringify({ scripts: { prepare: command } }),
    },
    {
      file: ".github/workflows/ci.yml",
      source: (command: string) =>
        workflow(`    steps:\n      - run: ${command}`),
    },
  ];
  for (const command of commands)
    for (const option of [
      (pin: string) => `--toolchain ${pin}`,
      (pin: string) => `--toolchain=${pin}`,
    ])
      for (const { file, source } of surfaces) {
        expect(check(file, source(`${command} ${option(rust)}`))).toEqual([]);
        for (const mutation of ["nightly", "stable", "1.97.1", "''"]) {
          expect(option(mutation)).not.toBe(option(rust));
          expect(
            check(file, source(`${command} ${option(mutation)}`)),
          ).toHaveLength(1);
        }
        expect(check(file, source(command))).toEqual([]);
      }
  for (const command of commands) {
    expect(check("scripts/rust.sh", `${command} --toolchain`)).toHaveLength(1);
    expect(check("scripts/rust.sh", `${command} --toolchain=`)).toHaveLength(1);
    expect(
      check(
        "scripts/rust.sh",
        `${command} --toolchain=${rust} --toolchain=nightly`,
      ),
    ).toHaveLength(1);
  }
  expect(
    check(
      "scripts/rust.sh",
      `rustup target add --toolchain ${rust} wasm32-unknown-unknown`,
    ),
  ).toEqual([]);
  expect(
    check(
      "scripts/rust.sh",
      "rustup target add --toolchain nightly wasm32-unknown-unknown",
    ),
  ).toHaveLength(1);
  expect(
    check(
      "scripts/rust.sh",
      "echo 'rustup component add rustfmt --toolchain=nightly'",
    ),
  ).toEqual([]);
});

test("rustup installation aliases enforce the same exact selector policy", () => {
  for (const command of [
    "rustup toolchain install",
    "rustup toolchain add",
    "rustup install",
  ]) {
    expect(check("scripts/rust.sh", `${command} ${rust}`)).toEqual([]);
    expect(check("scripts/rust.sh", `${command} nightly`)).toMatchObject([
      { rule: "rust-version" },
    ]);
  }
});

test("Docker RUN and ENV instructions retain Rust pin enforcement", () => {
  const instructions = [
    (pin: string) => `RUN rustup default ${pin}`,
    (pin: string) => `RUN --mount=type=cache,target=/cache cargo +${pin} test`,
    (pin: string) => ["RUN rustup toolchain add " + "\\", pin].join("\n"),
    (pin: string) => `RUN ["rustup", "default", "${pin}"]`,
    (pin: string) => `RUN ["sh", "-c", "rustup default ${pin}"]`,
    (pin: string) => `RUN [ -f Cargo.toml ] && cargo +${pin} test`,
    (pin: string) => `RUN [ -f Cargo.toml ] && rustup default ${pin}`,
    (pin: string) => `RUN <<'SCRIPT'\ncargo +${pin} test\nSCRIPT`,
    (pin: string) => `RUN <<SCRIPT bash\nrustup default ${pin}\nSCRIPT`,
    (pin: string) => `ENV RUSTUP_TOOLCHAIN=${pin}`,
    (pin: string) => `ENV OTHER=value RUSTUP_TOOLCHAIN="${pin}"`,
    (pin: string) => `ENV RUSTUP_TOOLCHAIN ${pin}`,
  ];
  for (const instruction of instructions) {
    const positive = `FROM rust:${rust}\n${instruction(rust)}`;
    const mutation = `FROM rust:${rust}\n${instruction("nightly")}`;
    expect(positive).not.toBe(mutation);
    expect(check("Dockerfile", positive)).toEqual([]);
    expect(check("Dockerfile", mutation)).toMatchObject([
      { rule: "rust-version", line: 2 },
    ]);
  }
  expect(
    check(
      "Dockerfile",
      `FROM rust:${rust}\nRUN echo 'cargo +nightly test'\nRUN cat <<'DATA'\ncargo +nightly test\nDATA`,
    ),
  ).toEqual([]);
  expect(
    check(
      "Dockerfile",
      `FROM rust:${rust}\nRUN ["echo", "$(rustup default nightly)", "apostrophe's"]\nENV NOTES="$(rustup default nightly)" RUSTUP_TOOLCHAIN=${rust}`,
    ),
  ).toEqual([]);
  expect(
    check(
      "Dockerfile",
      `FROM rust:${rust}\nRUN echo okay\n\nENV RUSTUP_TOOLCHAIN=nightly`,
    ),
  ).toMatchObject([{ rule: "rust-version", line: 4 }]);
});

test("Docker ENV parses every assignment without shell command boundaries", () => {
  const instructions = [
    (pin: string) => `ENV OTHER=value; RUSTUP_TOOLCHAIN=${pin}`,
    (pin: string) => `ENV OTHER=value& RUSTUP_TOOLCHAIN=${pin}`,
    (pin: string) => `ENV OTHER=value| RUSTUP_TOOLCHAIN=${pin}`,
    (pin: string) => `ENV OTHER=#literal RUSTUP_TOOLCHAIN=${pin}`,
    (pin: string) => `ENV OTHER="spaces ; & | #" RUSTUP_TOOLCHAIN='${pin}'`,
    (pin: string) => `ENV OTHER=escaped\\ space RUSTUP_TOOLCHAIN="${pin}"`,
    (pin: string) => `ENV RUSTUP_TOOLCHAIN=${rust} RUSTUP_TOOLCHAIN=${pin}`,
    (pin: string) => `ENV RUSTUP_TOOLCHAIN "${pin}"`,
    (pin: string) => `ENV RUSTUP_TOOLCHAIN '${pin}'`,
    (pin: string) => `ENV RUSTUP_TOOLCHAIN=${pin.slice(0, 2)}"${pin.slice(2)}"`,
  ];
  for (const instruction of instructions) {
    const positive = `FROM rust:${rust}\n${instruction(rust)}`;
    const mutation = `FROM rust:${rust}\n${instruction("nightly")}`;
    expect(positive).not.toBe(mutation);
    expect(check("Dockerfile", positive)).toEqual([]);
    expect(check("Dockerfile", mutation)).toMatchObject([
      { rule: "rust-version", line: 2 },
    ]);
  }
  for (const value of [
    "ENV OTHER value; RUSTUP_TOOLCHAIN=nightly",
    'ENV OTHER="RUSTUP_TOOLCHAIN=nightly; $(rustup default nightly)"',
    "ENV OTHER='quote \\\" and ;' RUSTUP_TOOLCHAIN=1.99.0",
  ])
    expect(check("Dockerfile", `FROM rust:${rust}\n${value}`)).toEqual([]);
  expect(
    check(
      "Dockerfile",
      "# escape=`\nFROM rust:1.99.0\nENV OTHER=escaped` space RUSTUP_TOOLCHAIN=1.99.0",
    ),
  ).toEqual([]);
  expect(
    check(
      "Dockerfile",
      "# escape=`\nFROM rust:1.99.0\nENV OTHER=escaped` space RUSTUP_TOOLCHAIN=nightly",
    ),
  ).toHaveLength(1);
  expect(
    check(
      "Dockerfile",
      `FROM rust:${rust}\nENV RUSTUP_TOOLCHAIN ${rust} extra`,
    ),
  ).toHaveLength(1);
});

test("Docker leading heredocs retain stdin redirection order", () => {
  for (const header of [
    "RUN <<'DATA' bash </dev/null",
    "RUN <<'DATA' bash <script.sh",
    "RUN <<'DATA' bash 0<&-",
  ]) {
    const source = (pin: string) =>
      `FROM rust:${rust}\n${header}\ncargo +${pin} test\nDATA`;
    expect(check("Dockerfile", source(rust))).toEqual([]);
    expect(check("Dockerfile", source("nightly"))).toEqual([]);
  }
  for (const header of [
    "RUN <<'DATA'",
    "RUN <<'DATA' bash",
    "RUN </dev/null bash <<'DATA'",
  ]) {
    const source = (pin: string) =>
      `FROM rust:${rust}\n${header}\ncargo +${pin} test\nDATA`;
    expect(check("Dockerfile", source(rust))).toEqual([]);
    expect(check("Dockerfile", source("nightly"))).toMatchObject([
      { rule: "rust-version" },
    ]);
  }
});
