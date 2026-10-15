/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import policy from "../toolchain.json";
import { cloudSetupArtifacts } from "./cloud-setup-artifacts";
import {
  cloudExtraTools,
  cloudInstallCommand,
  cloudRustComponentBinaries,
  parseCloudSetup,
  type CloudExtraTool,
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
  tools: Object.fromEntries(
    cloudExtraTools.map((tool) => [tool, cloudSetupArtifacts[tool].version]),
  ),
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

const createFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-tools-test-"));
  const managed = join(directory, "managed");
  const cargoBin = join(managed, "cargo/bin");
  const networkMarker = join(directory, "network-attempt");
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
  --version) printf '%s\\n' 'rustup ${cloudSetupArtifacts["rustup-init"].version} (fixture 2026-10-15)' ;;
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
  const toolPath = (tool: CloudExtraTool, binary: string) =>
    join(managed, "tools", tool, cloudSetupArtifacts[tool].version, binary);
  const writeTool = (tool: CloudExtraTool, binary: string, version: string) => {
    const path = toolPath(tool, binary);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${binary} ${version}'\n`, {
      mode: 0o755,
    });
  };
  for (const tool of cloudExtraTools)
    for (const binary of Object.keys(cloudSetupArtifacts[tool].amd64.binaries))
      writeTool(tool, binary, cloudSetupArtifacts[tool].version);
  const rewritten = fragment
    .replaceAll("/opt/stll-cloud", managed)
    .replaceAll("/usr/local/bin", join(directory, "bin"));
  expect(rewritten).not.toContain("/opt/stll-cloud");
  expect(rewritten).not.toContain("/usr/local/bin");
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
          FIXTURE_COMPONENTS: installedComponents,
          FIXTURE_MISSING_TOOLCHAIN: "0",
          ...env,
        },
      },
    );
  return { directory, networkMarker, run, toolPath, writeTool };
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
  withFixture(({ run, networkMarker }) => {
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
  });
});

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
});

test("every declared tool rejects incomplete cached binaries and version prefix collisions", () => {
  withFixture(({ run, toolPath, writeTool }) => {
    const exercised = new Set<string>();
    for (const tool of cloudExtraTools) {
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
    expect([...exercised].sort()).toEqual(cloudExtraTools.map(String).sort());
    expect([...exercised].sort()).toEqual(
      Object.keys(cloudSetupArtifacts)
        .filter((tool) => tool !== "rustup-init")
        .sort(),
    );
    expect(run("verify_tools").exitCode).toBe(0);
  });
});
