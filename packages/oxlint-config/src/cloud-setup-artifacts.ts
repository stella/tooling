type CloudSetupArtifact = {
  url: `https://${string}`;
  sha256: string;
  archive: "binary" | "tar.gz";
  binaries: Readonly<Record<string, string>>;
};

type CloudSetupArtifactRelease = {
  version: string;
  amd64: CloudSetupArtifact;
  arm64: CloudSetupArtifact;
};

const wasmBindgen0126 = {
  version: "0.2.126",
  amd64: {
    url: "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.126/wasm-bindgen-0.2.126-x86_64-unknown-linux-musl.tar.gz",
    sha256: "064948d58e2d6c0a745216477a639ba696216d6309aaa902939d1b865b1d869d",
    archive: "tar.gz",
    binaries: {
      "wasm-bindgen-test-runner":
        "wasm-bindgen-0.2.126-x86_64-unknown-linux-musl/wasm-bindgen-test-runner",
      wasm2es6js: "wasm-bindgen-0.2.126-x86_64-unknown-linux-musl/wasm2es6js",
      "wasm-bindgen":
        "wasm-bindgen-0.2.126-x86_64-unknown-linux-musl/wasm-bindgen",
    },
  },
  arm64: {
    url: "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.126/wasm-bindgen-0.2.126-aarch64-unknown-linux-musl.tar.gz",
    sha256: "2245120254a9f6c9a9adf3601f3d52bb31309219e9ceab7696e74e24885c440a",
    archive: "tar.gz",
    binaries: {
      "wasm-bindgen-test-runner":
        "wasm-bindgen-0.2.126-aarch64-unknown-linux-musl/wasm-bindgen-test-runner",
      wasm2es6js: "wasm-bindgen-0.2.126-aarch64-unknown-linux-musl/wasm2es6js",
      "wasm-bindgen":
        "wasm-bindgen-0.2.126-aarch64-unknown-linux-musl/wasm-bindgen",
    },
  },
} as const satisfies CloudSetupArtifactRelease;

/** Pinned upstream Linux artifacts, verified against their published SHA-256 sums. */
export const cloudSetupArtifacts = {
  "rustup-init": {
    version: "1.29.1",
    amd64: {
      url: "https://static.rust-lang.org/rustup/archive/1.29.1/x86_64-unknown-linux-gnu/rustup-init",
      sha256:
        "dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71",
      archive: "binary",
      binaries: {
        "rustup-init": "rustup-init",
      },
    },
    arm64: {
      url: "https://static.rust-lang.org/rustup/archive/1.29.1/aarch64-unknown-linux-gnu/rustup-init",
      sha256:
        "15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433",
      archive: "binary",
      binaries: {
        "rustup-init": "rustup-init",
      },
    },
  },
  "cargo-nextest": {
    version: "0.9.148",
    amd64: {
      url: "https://github.com/nextest-rs/nextest/releases/download/cargo-nextest-0.9.148/cargo-nextest-0.9.148-x86_64-unknown-linux-musl.tar.gz",
      sha256:
        "bf92cb81450872d960ffa13857a83084d557ec0cdc141663d263bb23ef756f97",
      archive: "tar.gz",
      binaries: {
        "cargo-nextest": "cargo-nextest",
      },
    },
    arm64: {
      url: "https://github.com/nextest-rs/nextest/releases/download/cargo-nextest-0.9.148/cargo-nextest-0.9.148-aarch64-unknown-linux-musl.tar.gz",
      sha256:
        "94676506ceaed01746d78cfe9ed124ee841b2932fd18d9d10f438a347bd9ba5e",
      archive: "tar.gz",
      binaries: {
        "cargo-nextest": "cargo-nextest",
      },
    },
  },
  "wasm-bindgen-cli": {
    version: "0.2.129",
    amd64: {
      url: "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.129/wasm-bindgen-0.2.129-x86_64-unknown-linux-musl.tar.gz",
      sha256:
        "82d12bb940e2d4e72e0d5605387fc1b8ca179044e012b620f0ce4e7440e8320e",
      archive: "tar.gz",
      binaries: {
        "wasm-bindgen-test-runner":
          "wasm-bindgen-0.2.129-x86_64-unknown-linux-musl/wasm-bindgen-test-runner",
        wasm2es6js: "wasm-bindgen-0.2.129-x86_64-unknown-linux-musl/wasm2es6js",
        "wasm-bindgen":
          "wasm-bindgen-0.2.129-x86_64-unknown-linux-musl/wasm-bindgen",
      },
    },
    arm64: {
      url: "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.129/wasm-bindgen-0.2.129-aarch64-unknown-linux-musl.tar.gz",
      sha256:
        "2ed4351c35dd9440308bbb02767d47ea278efe851a52465300f3c94f5b6c2a87",
      archive: "tar.gz",
      binaries: {
        "wasm-bindgen-test-runner":
          "wasm-bindgen-0.2.129-aarch64-unknown-linux-musl/wasm-bindgen-test-runner",
        wasm2es6js:
          "wasm-bindgen-0.2.129-aarch64-unknown-linux-musl/wasm2es6js",
        "wasm-bindgen":
          "wasm-bindgen-0.2.129-aarch64-unknown-linux-musl/wasm-bindgen",
      },
    },
  },
  uv: {
    version: "0.13.1",
    amd64: {
      url: "https://github.com/astral-sh/uv/releases/download/0.13.1/uv-x86_64-unknown-linux-musl.tar.gz",
      sha256:
        "6c86040a8f045ab9adc9e3ec4cdafa03fd00e9a988ed2bf28971c7fc2d0debd0",
      archive: "tar.gz",
      binaries: {
        uv: "uv-x86_64-unknown-linux-musl/uv",
        uvx: "uv-x86_64-unknown-linux-musl/uvx",
      },
    },
    arm64: {
      url: "https://github.com/astral-sh/uv/releases/download/0.13.1/uv-aarch64-unknown-linux-musl.tar.gz",
      sha256:
        "345a8308e4d1835cdfaadf692836fd3137a6d45864773f05ad7bf59442b1ba16",
      archive: "tar.gz",
      binaries: {
        uv: "uv-aarch64-unknown-linux-musl/uv",
        uvx: "uv-aarch64-unknown-linux-musl/uvx",
      },
    },
  },
} as const satisfies Record<string, CloudSetupArtifactRelease>;

export type CloudSetupArtifactTool = keyof typeof cloudSetupArtifacts;
export type CloudSetupArchitecture = keyof Omit<
  (typeof cloudSetupArtifacts)[CloudSetupArtifactTool],
  "version"
>;

/** Explicit releases whose CLI must match a project's wasm-bindgen crate exactly. */
export const wasmBindgenArtifactReleases = [
  wasmBindgen0126,
  cloudSetupArtifacts["wasm-bindgen-cli"],
] as const;

/** Every supported version participates in lookup and catalog validation. */
export const cloudSetupArtifactVersions = {
  "rustup-init": [cloudSetupArtifacts["rustup-init"]],
  "cargo-nextest": [cloudSetupArtifacts["cargo-nextest"]],
  "wasm-bindgen-cli": wasmBindgenArtifactReleases,
  uv: [cloudSetupArtifacts.uv],
} as const satisfies Record<
  CloudSetupArtifactTool,
  readonly CloudSetupArtifactRelease[]
>;

/** A new version requires an explicit, verified catalog entry; never build from source. */
export const getCloudSetupArtifact = (
  tool: CloudSetupArtifactTool,
  version: string,
) => {
  const releases = cloudSetupArtifactVersions[tool];
  const artifact = releases.find((release) => release.version === version);
  if (artifact === undefined)
    throw new Error(
      `Unsupported ${tool} version ${version}; supported versions: ${releases.map((release) => release.version).join(", ")}`,
    );
  return artifact;
};
