/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import policy from "../toolchain.json";
import {
  cloudSetupArtifacts,
  cloudSetupPackages,
} from "./cloud-setup-artifacts";
import {
  cloudArtifactTools,
  cloudExtraTools,
  cloudInstallCommand,
  cloudPackageTools,
  cloudRustComponentBinaries,
  parseCloudSetup,
  type CloudArtifactTool,
} from "./cloud-setup-schema";
import { resolveCloudToolchains } from "./cloud-setup-toolchains";
import { renderCloudToolInstall } from "./cloud-setup-tools-install";

const host = "x86_64-unknown-linux-gnu";
const components = Object.keys(cloudRustComponentBinaries);
const installedComponents = components
  .map((name) => (name === "rust-src" ? name : `${name}-${host}`))
  .join("\n");
const cloud = parseCloudSetup({
  install: cloudInstallCommand,
  rust: { components, targets: ["wasm32-unknown-unknown"] },
  tools: {
    ...Object.fromEntries(
      cloudArtifactTools.map((tool) => [
        tool,
        cloudSetupArtifacts[tool].version,
      ]),
    ),
    ...Object.fromEntries(
      cloudPackageTools.map((tool) => [tool, cloudSetupPackages[tool].version]),
    ),
  },
});
if (cloud === undefined) throw new Error("Expected cloud tool fixture");
const fragment = renderCloudToolInstall(
  resolveCloudToolchains({
    cloud,
    rust: policy.rust,
    rustExceptions: [],
    files: {
      "Cargo.lock": `[[package]]\nname = "wasm-bindgen"\nversion = "${cloudSetupArtifacts["wasm-bindgen-cli"].version}"\n`,
    },
  }),
);

const createFixture = (selection = fragment) => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-tools-test-"));
  const managed = join(directory, "managed");
  const cargoBin = join(managed, "cargo/bin");
  const networkMarker = join(directory, "network-attempt");
  const networkCalls = join(directory, "bounded-network-calls");
  mkdirSync(cargoBin, { recursive: true });
  mkdirSync(join(managed, "rustup"), { recursive: true });
  const environmentCheck = `
if [ "$RUSTUP_AUTO_INSTALL" != 0 ] || [ "$RUSTUP_TOOLCHAIN" != "$FIXTURE_TOOLCHAIN" ] || [ "$RUSTUP_DIST_SERVER" != https://static.rust-lang.org ] || [ "$RUSTUP_UPDATE_ROOT" != https://static.rust-lang.org/rustup ]; then
  printf '%s\\n' network > "$FIXTURE_NETWORK"
  exit 91
fi
`;
  writeFileSync(
    join(cargoBin, "rustup"),
    `#!/bin/sh
${environmentCheck}
case "$*" in
  --version)
    if [ "$FIXTURE_RUSTUP_OLD" = 1 ]; then printf '%s\\n' 'rustup 0.0.1 (fixture)';
    else printf '%s\\n' 'rustup ${cloudSetupArtifacts["rustup-init"].version} (fixture 2026-10-15)'; fi ;;
  "set auto-self-update disable") : ;;
  "component list --toolchain $FIXTURE_TOOLCHAIN --installed") printf '%s\\n' "$FIXTURE_COMPONENTS" ;;
  "target list --toolchain $FIXTURE_TOOLCHAIN --installed") printf '%s\\n' wasm32-unknown-unknown ;;
  *) exit 92 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(cargoBin, "rustc"),
    `#!/bin/sh
${environmentCheck}
[ "$FIXTURE_MISSING_TOOLCHAIN" = 0 ] || exit 1
case "$*" in
  "+$FIXTURE_TOOLCHAIN --version") printf '%s\\n' "rustc $FIXTURE_TOOLCHAIN (fixture 2026-10-15)" ;;
  "+$FIXTURE_TOOLCHAIN -vV") printf '%s\\n' "host: ${host}" ;;
  *) exit 93 ;;
esac
`,
    { mode: 0o755 },
  );
  const toolPath = (tool: CloudArtifactTool, binary: string) =>
    join(managed, "tools", tool, cloudSetupArtifacts[tool].version, binary);
  const writeTool = (
    tool: CloudArtifactTool,
    binary: string,
    version: string,
  ) => {
    const path = toolPath(tool, binary);
    mkdirSync(join(path, ".."), { recursive: true });
    const identity = binary === "gitleaks" ? "gitleaks version" : binary;
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s\\n' '${identity} ${version}'\n`,
      {
        mode: 0o755,
      },
    );
  };
  for (const tool of cloudArtifactTools)
    for (const binary of Object.keys(cloudSetupArtifacts[tool].amd64.binaries))
      writeTool(tool, binary, cloudSetupArtifacts[tool].version);
  const timePath = join(directory, "usr-bin-time");
  const writeTime = (identity: string) =>
    writeFileSync(
      timePath,
      `#!/bin/sh\n[ "$1" = --version ] || exit 96\nprintf '%s\\n' '${identity}' 'Copyright (C) 2018 Free Software Foundation, Inc.'\n`,
      { mode: 0o755 },
    );
  writeTime("time (GNU Time) UNKNOWN");
  const rewritten = selection
    .replaceAll("/opt/stll-cloud", managed)
    .replaceAll("/usr/local/bin", join(directory, "bin"))
    .replaceAll(cloudSetupPackages.time.binary, timePath);
  expect(rewritten).not.toContain("/opt/stll-cloud");
  expect(rewritten).not.toContain("/usr/local/bin");
  expect(rewritten).not.toContain(cloudSetupPackages.time.binary);
  const run = (command: string, env: Record<string, string> = {}) =>
    Bun.spawnSync(
      [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        `
fail() { printf '%s\\n' "$*" >&2; exit 1; }
stat() {
  [[ "$1" == -c && "$2" == %u ]] || return 95
  printf '%s\\n' "$FIXTURE_OWNER"
}
runuser() {
  [[ "$1" == -u && "$2" == fixture-user && "$3" == -- ]] || return 94
  shift 3
  "$@"
}
dpkg-query() {
  [[ "$*" == '-W -f=\${Version} time' && -n "$FIXTURE_TIME_PACKAGE" ]] || return 1
  printf '%s' "$FIXTURE_TIME_PACKAGE"
}
network_run() {
  printf '%s\\n' "$@" >> "$FIXTURE_NETWORK_CALLS"
  [[ "$FIXTURE_NETWORK_STATUS" == 0 ]] || return "$FIXTURE_NETWORK_STATUS"
  shift 2
  "$@"
}
${rewritten}
${command}
`,
      ],
      {
        env: {
          ...process.env,
          OUTPUT_USER: "fixture-user",
          OUTPUT_UID: "1234",
          FIXTURE_OWNER: "1234",
          OUTPUT_HOME: directory,
          RUSTUP_TOOLCHAIN: "nightly",
          RUSTUP_AUTO_INSTALL: "1",
          RUSTUP_DIST_SERVER: "https://fixture.invalid",
          RUSTUP_UPDATE_ROOT: "https://fixture.invalid/rustup",
          FIXTURE_TOOLCHAIN: policy.rust,
          FIXTURE_NETWORK: networkMarker,
          FIXTURE_NETWORK_CALLS: networkCalls,
          FIXTURE_NETWORK_STATUS: "0",
          FIXTURE_RUSTUP_OLD: "0",
          FIXTURE_COMPONENTS: installedComponents,
          FIXTURE_MISSING_TOOLCHAIN: "0",
          FIXTURE_TIME_PACKAGE: "1.9-0.2build1",
          ...env,
        },
      },
    );
  return {
    directory,
    networkMarker,
    networkCalls,
    run,
    timePath,
    toolPath,
    writeTime,
    writeTool,
  };
};

type ToolFixture = ReturnType<typeof createFixture>;
const withFixture = (check: (fixture: ToolFixture) => void) => {
  const fixture = createFixture();
  try {
    check(fixture);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
};

test("Rust readiness forces the pinned offline environment even when callers override it", () => {
  withFixture(({ run, networkMarker, networkCalls }) => {
    const command = `
[[ "$RUSTUP_AUTO_INSTALL" == 0 && "$RUSTUP_TOOLCHAIN" == "$FIXTURE_TOOLCHAIN" ]]
RUSTUP_AUTO_INSTALL=1 RUSTUP_TOOLCHAIN=nightly verify_rust
`;
    const ready = run(command);
    expect(ready.stderr.toString()).toBe("");
    expect(ready.exitCode).toBe(0);
    const foreign = run(command, { FIXTURE_OWNER: "5678" });
    expect(foreign.exitCode).toBe(1);
    expect(existsSync(networkMarker)).toBe(false);
    const missing = run(command, { FIXTURE_MISSING_TOOLCHAIN: "1" });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("run install");
    expect(existsSync(networkMarker)).toBe(false);
    expect(existsSync(networkCalls)).toBe(false);
  });
}, 15_000);

test("Rust readiness requires each exact component for the active host, never a name prefix", () => {
  withFixture(({ run }) => {
    for (const component of components) {
      for (const replacement of [
        `${component}-preview-${host}`,
        `${component}-aarch64-unknown-linux-gnu`,
      ]) {
        const installed = components
          .map((name) => {
            if (name === component) return replacement;
            return name === "rust-src" ? name : `${name}-${host}`;
          })
          .join("\n");
        const result = run("verify_rust", { FIXTURE_COMPONENTS: installed });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain("run install");
      }
    }
  });
}, 15_000);

test("every declared tool rejects incomplete cached binaries and version prefix collisions", () => {
  withFixture(({ run, toolPath, writeTool }) => {
    const exercised = new Set<string>();
    for (const tool of cloudArtifactTools) {
      exercised.add(tool);
      const verify = `verify_${tool.replaceAll("-", "_")}`;
      const release = cloudSetupArtifacts[tool];
      expect(run(verify).exitCode).toBe(0);
      for (const binary of Object.keys(release.amd64.binaries)) {
        rmSync(toolPath(tool, binary));
        expect(run(verify).exitCode).toBe(1);
        writeTool(tool, binary, release.version);
        expect(run(verify).exitCode).toBe(0);
      }
      const primary = tool === "wasm-bindgen-cli" ? "wasm-bindgen" : tool;
      writeTool(tool, primary, `${release.version} (fixture 2026-10-15)`);
      expect(run(verify).exitCode).toBe(0);
      writeTool(tool, primary, `${release.version}0`);
      expect(run(verify).exitCode).toBe(1);
      writeTool(tool, primary, release.version);
    }
    expect([...exercised].sort()).toEqual(
      cloudArtifactTools.map(String).sort(),
    );
    expect([...exercised].sort()).toEqual(
      Object.keys(cloudSetupArtifacts)
        .filter((tool) => tool !== "rustup-init")
        .sort(),
    );
    expect(run("verify_tools").exitCode).toBe(0);
  });
}, 15_000);

test("cached gitleaks installs restore the launcher without downloading", () => {
  withFixture(({ run, directory, toolPath }) => {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const result = run(`
      fetch_verified() { echo 'Unexpected download' >&2; return 99; }
      # macOS ln lacks GNU -T; the fixture still checks the generated arguments.
      ln() {
        [[ "$1" == -sfnT && "$2" == -- ]] || return 98
        shift 2
        command ln -sfn "$@"
      }
      install_gitleaks
      install_gitleaks
      export PATH='${bin}':"$PATH"
      [[ "$(command -v gitleaks)" == '${bin}/gitleaks' ]]
      [[ "$(gitleaks --version)" == 'gitleaks version 8.30.1' ]]
    `);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(bin, "gitleaks"), "utf8")).toBe(
      readFileSync(toolPath("gitleaks", "gitleaks"), "utf8"),
    );
  });
}, 15_000);

test("verified artifacts use the bounded downloader and never hash failed downloads", () => {
  withFixture(({ run, directory }) => {
    const payload = "artifact payload";
    const checksum = createHash("sha256").update(payload).digest("hex");
    const destination = join(directory, "artifact");
    const successful = run(
      `
      download_file() {
        [[ "$1" == https://github.com/example/archive.tar.gz && "$2" == "$FIXTURE_DESTINATION" && "$3" == 120 ]] || exit 90
        printf '%s' 'artifact payload' > "$2"
      }
      fetch_verified https://github.com/example/archive.tar.gz ${checksum} "$FIXTURE_DESTINATION"
    `,
      { FIXTURE_DESTINATION: destination },
    );
    expect(successful.exitCode).toBe(0);
    expect(readFileSync(destination, "utf8")).toBe(payload);
    const failed = run(
      `
      download_file() { return 73; }
      sha256sum() { printf '%s' hashed > "$FIXTURE_HASH_MARKER"; }
      fetch_verified https://github.com/example/archive.tar.gz ${checksum} "$FIXTURE_DESTINATION"
    `,
      {
        FIXTURE_DESTINATION: destination,
        FIXTURE_HASH_MARKER: join(directory, "hashed"),
      },
    );
    expect(failed.exitCode).toBe(73);
    expect(existsSync(join(directory, "hashed"))).toBe(false);
  });
}, 15_000);

test("Rust network execution passes one pinned environment through the bounded external command helper", () => {
  withFixture(({ run, networkCalls }) => {
    const successful = run(
      'rust_run network "$CARGO_HOME/bin/rustup" --version',
    );
    expect(successful.exitCode).toBe(0);
    expect(readFileSync(networkCalls, "utf8").split("\n").slice(0, 3)).toEqual([
      "static.rust-lang.org",
      "180",
      "runuser",
    ]);
    for (const status of [124, 137])
      expect(
        run('rust_run network "$CARGO_HOME/bin/rustup" --version', {
          FIXTURE_NETWORK_STATUS: String(status),
        }).exitCode,
      ).toBe(status);
    expect(
      run('rust_run invalid "$CARGO_HOME/bin/rustup" --version').exitCode,
    ).toBe(1);
  });
}, 15_000);

test("both Rust provisioning entrypoints stop on bounded network failure before later install work", () => {
  for (const entrypoint of ["installer", "toolchain"]) {
    withFixture(({ run, networkCalls }) => {
      const result = run(
        `
        apt_refresh_for() { [[ "$*" == build-essential ]] || exit 89; }
        apt_install() { [[ "$*" == build-essential ]] || exit 88; }
        fetch_verified() { printf '%s' fixture > "$3"; }
        primary_rust_ready() { return 1; }
        install_rust
      `,
        {
          FIXTURE_RUSTUP_OLD: entrypoint === "installer" ? "1" : "0",
          FIXTURE_NETWORK_STATUS: "124",
          ARCH: "amd64",
        },
      );
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(124);
      const call = readFileSync(networkCalls, "utf8").split("\n");
      expect(call.slice(0, 3)).toEqual([
        "static.rust-lang.org",
        "180",
        "runuser",
      ]);
      if (entrypoint === "installer") {
        expect(call.some((argument) => argument.endsWith("/rustup-init"))).toBe(
          true,
        );
        expect(call).toContain("--default-toolchain");
      } else {
        expect(call).toContain("toolchain");
        expect(call).toContain("install");
        expect(call).toContain(policy.rust);
      }
    });
  }
}, 15_000);

test("prebuilt tool downloads preserve bounded helper failure status and clean temporary files", () => {
  withFixture(({ run, directory, toolPath }) => {
    rmSync(toolPath("uv", "uv"));
    const scratchFile = join(directory, "download-scratch");
    const result = run(
      `
      download_file() {
        printf '%s' "$2" > "$FIXTURE_SCRATCH_FILE"
        [[ "$1" == https://github.com/* && "$3" == 120 ]] || exit 90
        return 73
      }
      install_uv
    `,
      { ARCH: "amd64", FIXTURE_SCRATCH_FILE: scratchFile },
    );
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(73);
    const downloadedPath = readFileSync(scratchFile, "utf8");
    expect(existsSync(join(downloadedPath, ".."))).toBe(false);
  });
}, 15_000);

test("the closed tool list is exactly the artifact and package catalogs", () => {
  expect(cloudExtraTools.map(String).sort()).toEqual(
    [...cloudArtifactTools, ...Object.keys(cloudSetupPackages)].sort(),
  );
}, 15_000);

test("GNU time readiness requires the GNU binary and the pinned Ubuntu package release", () => {
  withFixture(({ run, timePath, writeTime }) => {
    expect(run("verify_time").exitCode).toBe(0);
    expect(run("verify_tools").exitCode).toBe(0);
    for (const version of ["", "1.10-1", "1.9.1-1", "11.9-1", "1.9"])
      expect(
        run("verify_time", { FIXTURE_TIME_PACKAGE: version }).exitCode,
      ).toBe(1);
    const failed = run("verify_tools", { FIXTURE_TIME_PACKAGE: "" });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr.toString()).toContain(
      "Pinned time is unavailable; run install",
    );
    writeTime("time (BSD) 1.9");
    expect(run("verify_time").exitCode).toBe(1);
    rmSync(timePath);
    expect(run("verify_time").exitCode).toBe(1);
  });
}, 15_000);

test("GNU time installation skips present packages and otherwise uses bounded apt", () => {
  withFixture(({ run, directory, networkCalls, timePath, writeTime }) => {
    const calls = join(directory, "apt-calls");
    const apt = `
      apt_network() { printf 'network %s\\n' "$*" >> "$FIXTURE_APT_CALLS"; return "$FIXTURE_APT_STATUS"; }
      apt_install() { printf 'install %s\\n' "$*" >> "$FIXTURE_APT_CALLS"; [[ -z "$FIXTURE_APT_IDENTITY" ]] || printf '%s\\n' '#!/bin/sh' "printf '%s\\\\n' '$FIXTURE_APT_IDENTITY'" > "$FIXTURE_TIME_PATH"; chmod 755 "$FIXTURE_TIME_PATH"; }
      install_time
    `;
    const env = {
      FIXTURE_APT_CALLS: calls,
      FIXTURE_APT_STATUS: "0",
      FIXTURE_APT_IDENTITY: "time (GNU Time) UNKNOWN",
      FIXTURE_TIME_PATH: timePath,
    };
    const present = run(apt, env);
    expect(present.stderr.toString()).toBe("");
    expect(present.exitCode).toBe(0);
    expect(existsSync(calls)).toBe(false);

    rmSync(timePath);
    const installed = run(apt, env);
    expect(installed.stderr.toString()).toBe("");
    expect(installed.exitCode).toBe(0);
    expect(readFileSync(calls, "utf8")).toBe("network update\ninstall time\n");
    expect(run("verify_time").exitCode).toBe(0);

    rmSync(calls);
    rmSync(timePath);
    const timedOut = run(apt, { ...env, FIXTURE_APT_STATUS: "124" });
    expect(timedOut.exitCode).toBe(124);
    expect(readFileSync(calls, "utf8")).toBe("network update\n");
    expect(existsSync(timePath)).toBe(false);

    rmSync(calls);
    writeTime("time (BSD) 1.9");
    const mismatched = run(apt, { ...env, FIXTURE_APT_IDENTITY: "" });
    expect(mismatched.exitCode).toBe(1);
    expect(mismatched.stderr.toString()).toContain(
      "Installed time version differs from its pin",
    );
    expect(existsSync(networkCalls)).toBe(false);
  });
}, 15_000);

test("explicit additional Rust installs once and is required by offline readiness", () => {
  const selected = parseCloudSetup({
    install: cloudInstallCommand,
    rust: { additionalToolchains: ["1.97.1"] },
  });
  if (selected === undefined) throw new Error("Cloud fixture absent");
  const fixture = createFixture(
    renderCloudToolInstall(
      resolveCloudToolchains({
        cloud: selected,
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
      }),
    ),
  );
  try {
    const installed = join(fixture.directory, "additional-installed");
    const cargoBin = join(fixture.directory, "managed/cargo/bin");
    mkdirSync(join(fixture.directory, "bin"));
    writeFileSync(
      join(cargoBin, "rustc"),
      `#!/bin/sh
[ "$RUSTUP_AUTO_INSTALL" = 0 ] || exit 95
case "$*" in
  "+$FIXTURE_TOOLCHAIN --version") printf '%s\\n' "rustc $FIXTURE_TOOLCHAIN (fixture)" ;;
  "+$FIXTURE_TOOLCHAIN -vV") printf '%s\\n' "host: ${host}" ;;
  "+1.97.1 --version") [ -f "$FIXTURE_ADDITIONAL_INSTALLED" ] || exit 1; printf '%s\\n' 'rustc 1.97.1 (fixture)' ;;
  *) exit 94 ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(cargoBin, "rustup"),
      `#!/bin/sh
[ "$RUSTUP_AUTO_INSTALL" = 0 ] || exit 95
case "$*" in
  --version) printf '%s\\n' 'rustup ${cloudSetupArtifacts["rustup-init"].version} (fixture)' ;;
  "set auto-self-update disable"|"default $FIXTURE_TOOLCHAIN") : ;;
  "toolchain install 1.97.1 --profile minimal --no-self-update") printf '%s' installed > "$FIXTURE_ADDITIONAL_INSTALLED" ;;
  *) exit 94 ;;
esac
`,
      { mode: 0o755 },
    );
    const env = { FIXTURE_ADDITIONAL_INSTALLED: installed };
    const missing = fixture.run("verify_rust", env);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("run install");
    expect(existsSync(fixture.networkCalls)).toBe(false);
    const command = `apt_refresh_for() { :; }; apt_install() { :; }; install_rust; verify_rust`;
    const first = fixture.run(command, env);
    expect(first.stderr.toString()).toBe("");
    expect(first.exitCode).toBe(0);
    const calls = readFileSync(fixture.networkCalls, "utf8");
    expect(calls).toContain("static.rust-lang.org\n180\nrunuser");
    expect(
      calls.split("\n").filter((value) => value === "1.97.1"),
    ).toHaveLength(1);
    expect(calls.split("\n")).not.toContain(policy.rust);
    const cached = fixture.run(command, env);
    expect(cached.stderr.toString()).toBe("");
    expect(cached.exitCode).toBe(0);
    expect(readFileSync(fixture.networkCalls, "utf8")).toBe(calls);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
}, 15_000);
