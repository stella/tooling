/// <reference types="bun-types" />
import { expect, test } from "bun:test";

import policyInput from "../toolchain.json";
import { generateCloudSetup } from "./cloud-setup";
import { cloudSetupArtifacts } from "./cloud-setup-artifacts";
import { cloudInstallCommand, parseCloudSetup } from "./cloud-setup-schema";
import { resolveCloudToolchains } from "./cloud-setup-toolchains";
import { parseToolchainPolicy } from "./toolchain-schema";

const policy = parseToolchainPolicy(policyInput);
const resolve = (
  input: Record<string, unknown>,
  files: Record<string, string> = {},
) => {
  const cloud = parseCloudSetup({
    install: cloudInstallCommand,
    ...input,
  });
  if (cloud === undefined) throw new Error("cloud declaration absent");
  return resolveCloudToolchains({
    cloud,
    files,
    rust: policy.rust,
    rustExceptions: [],
  });
};
const rustFile = `[toolchain]\nchannel = "${policy.rust}"\nprofile = "minimal"\ncomponents = ["clippy", "rustfmt"]\ntargets = ["wasm32-unknown-unknown"]\n`;
const lock = (versions: string[]) =>
  `version = 4\n${versions.map((version) => `[[package]]\nname = "wasm-bindgen"\nversion = "${version}"\n`).join("\n")}`;

test("Rust selection derives from one root file or an explicit policy declaration", () => {
  expect(resolve({}).rust).toBeUndefined();
  expect(resolve({ rust: {} }).rust?.channel).toBe(policy.rust);
  const result = resolve(
    {
      rust: {
        components: ["rust-src"],
        targets: ["wasm32-wasip1-threads", "x86_64-unknown-linux-gnu"],
      },
    },
    { "rust-toolchain.toml": rustFile },
  );
  expect(result.rust?.components).toEqual(["clippy", "rust-src", "rustfmt"]);
  expect(result.rust?.targets).toEqual([
    "wasm32-unknown-unknown",
    "wasm32-wasip1-threads",
    "x86_64-unknown-linux-gnu",
  ]);
  expect(() =>
    resolve(
      { rust: { toolchain: "1.1.0" } },
      { "rust-toolchain.toml": rustFile },
    ),
  ).toThrow("conflicts");
  for (const channel of ["stable", "nightly", "1.1.0", "../local"]) {
    expect(() =>
      resolve(
        {},
        { "rust-toolchain.toml": `[toolchain]\nchannel = "${channel}"\n` },
      ),
    ).toThrow();
  }
  expect(() =>
    resolve(
      {},
      { "rust-toolchain.toml": rustFile, "rust-toolchain": policy.rust },
    ),
  ).toThrow("one root");
  expect(() =>
    resolve({}, { "rust-toolchain.toml": '[toolchain]\npath = "local"\n' }),
  ).toThrow();
});

test("a recorded Rust exception authorizes exactly its pin", () => {
  const cloud = parseCloudSetup({
    install: cloudInstallCommand,
    rust: { toolchain: "1.97.1" },
  });
  if (cloud === undefined) throw new Error("cloud declaration absent");
  expect(
    resolveCloudToolchains({
      cloud,
      files: {},
      rust: policy.rust,
      rustExceptions: [
        {
          pin: "1.97.1",
          reason: "Compiler dependency",
          tracking: "https://github.com/stella/tooling/issues/99",
          expires: "2099-01-01",
        },
      ],
    }).rust?.channel,
  ).toBe("1.97.1");
});

test("extra tools form a closed exact-pin selection and require their inputs", () => {
  for (const tools of [
    [],
    null,
    { arbitrary: "1.0.0" },
    { uv: "latest" },
    { uv: "0.13.1;true" },
    { uv: undefined },
  ])
    expect(() => resolve({ tools })).toThrow();
  for (const rust of [
    false,
    "stable",
    { extra: true },
    { toolchain: "stable" },
    { components: "clippy" },
    { targets: ["../target"] },
    { targets: ["x", "x"] },
  ])
    expect(() => resolve({ rust })).toThrow();
  expect(() =>
    resolve({
      tools: { "cargo-nextest": cloudSetupArtifacts["cargo-nextest"].version },
    }),
  ).toThrow("requires a Rust toolchain");
  expect(() => resolve({ tools: { uv: "0.0.1" } })).toThrow("Unsupported uv");
});

test("wasm-bindgen CLI equals the unique locked crate version", () => {
  const version = cloudSetupArtifacts["wasm-bindgen-cli"].version;
  const declaration = { tools: { "wasm-bindgen-cli": version } };
  expect(
    resolve(declaration, { "Cargo.lock": lock([version]) }).tools,
  ).toHaveLength(1);
  for (const versions of [["0.1.0"], [version, "0.1.0"]])
    expect(() =>
      resolve(declaration, { "Cargo.lock": lock(versions) }),
    ).toThrow("must equal");
  expect(() => resolve(declaration, { "Cargo.lock": lock([]) })).toThrow(
    "requires package entries",
  );
  expect(() => resolve(declaration)).toThrow("tracked root Cargo.lock");
});

test("all tool subsets emit executable Bash and persistent pinned launchers", () => {
  const entries = Object.entries(cloudSetupArtifacts).filter(
    ([tool]) => tool !== "rustup-init",
  );
  for (let mask = 0; mask < 2 ** entries.length; mask++) {
    const tools = Object.fromEntries(
      entries
        .filter((_, index) => (mask & (1 << index)) !== 0)
        .map(([tool, release]) => [tool, release.version]),
    );
    const cloud = parseCloudSetup({ install: cloudInstallCommand, tools });
    if (cloud === undefined) throw new Error("cloud declaration absent");
    const script = generateCloudSetup({
      policy,
      cloud,
      nodeVersion: "26.10.0",
      files: {
        "rust-toolchain.toml": rustFile,
        "Cargo.lock": lock([cloudSetupArtifacts["wasm-bindgen-cli"].version]),
      },
    });
    const result = Bun.spawnSync(["bash", "-n"], {
      stdin: Buffer.from(script),
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(script).toContain("export RUSTUP_HOME=/opt/stll-cloud/rustup");
    expect(script).toContain("/usr/local/bin/$tool");
    expect(script).not.toMatch(/cargo install|curl[^\n]*\|\s*(?:sh|bash)/);
    expect(script).toContain("rust-toolchain.toml changed; regenerate");
    expect(script).not.toMatch(/@[A-Z_]+@/);
  }
});
