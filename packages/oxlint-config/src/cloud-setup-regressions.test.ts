/// <reference types="bun-types" />
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import policyInput from "../toolchain.json";
import { generateCloudSetup } from "./cloud-setup";
import { cloudInstallCommand, parseCloudSetup } from "./cloud-setup-schema";
import { parseToolchainPolicy } from "./toolchain-schema";

const policy = parseToolchainPolicy(policyInput);
const archivePins = (
  releases: Readonly<Record<string, { amd64: string; arm64: string }>>,
  version: string,
) => {
  const pins = releases[version];
  if (pins === undefined)
    throw new Error(`Missing fixture pins for ${version}`);
  return pins;
};
const generate = (rust: boolean) => {
  const cloud = parseCloudSetup({ install: cloudInstallCommand });
  if (cloud === undefined) throw new Error("Cloud fixture missing");
  return generateCloudSetup({
    policy,
    cloud,
    nodeVersion: "26.10.0",
    files: rust
      ? { "rust-toolchain.toml": `[toolchain]\nchannel = "${policy.rust}"\n` }
      : {},
  });
};
const withFixture = (run: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "cloud-regression-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const runtimeFunctions = (rust = false) => {
  const generated = generate(rust);
  const start = generated.indexOf("node_ready() {");
  const end = generated.indexOf("dependency_install() {", start);
  if (start < 0 || end <= start) throw new Error("Runtime functions missing");
  return generated.slice(start, end);
};
const binary = (path: string, output: string, status = 0) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${status}\n`,
    { mode: 0o755 },
  );
};

test("Rust and runtime-only scripts have one final newline and clean Git patches", () => {
  for (const rust of [false, true]) {
    withFixture((root) => {
      const script = generate(rust);
      expect(script).not.toMatch(/[ \t]+$/m);
      expect(script.match(/\n+$/)?.at(0)).toBe("\n");
      mkdirSync(join(root, ".agents"));
      const path = join(root, ".agents/cloud-setup.sh");
      writeFileSync(path, "");
      expect(Bun.spawnSync(["git", "init", "--quiet", root]).exitCode).toBe(0);
      expect(
        Bun.spawnSync(["git", "-C", root, "add", ".agents/cloud-setup.sh"])
          .exitCode,
      ).toBe(0);
      writeFileSync(path, script);
      const checked = Bun.spawnSync([
        "git",
        "-C",
        root,
        "diff",
        "--check",
        "--",
        ".agents/cloud-setup.sh",
      ]);
      expect(checked.stdout.toString()).toBe("");
      expect(checked.stderr.toString()).toBe("");
      expect(checked.exitCode).toBe(0);
    });
  }
});

test("cached Node requires working matching npm and npx launchers", () => {
  const cases = [
    { npm: "10.1.0", npx: "10.1.0", expected: 0 },
    { npm: undefined, npx: "10.1.0", expected: 1 },
    { npm: "10.1.0", npx: undefined, expected: 1 },
    { npm: "", npx: "", expected: 1 },
    { npm: "invalid", npx: "invalid", expected: 1 },
    { npm: "10.1.0", npx: "10.2.0", expected: 1 },
    { npm: "10.1.0", npx: "10.1.0", npmStatus: 2, expected: 1 },
    { npm: "10.1.0", npx: "10.1.0", npxStatus: 2, expected: 1 },
  ];
  for (const fixture of cases) {
    withFixture((root) => {
      binary(join(root, "bin/node"), "v26.10.0");
      if (fixture.npm !== undefined)
        binary(join(root, "bin/npm"), fixture.npm, fixture.npmStatus);
      if (fixture.npx !== undefined)
        binary(join(root, "bin/npx"), fixture.npx, fixture.npxStatus);
      const result = Bun.spawnSync(
        ["bash", "-euo", "pipefail", "-c", `${runtimeFunctions()}\nnode_ready`],
        {
          env: { ...process.env, NODE_DIR: root, NODE_VERSION: "26.10.0" },
        },
      );
      expect(result.exitCode).toBe(fixture.expected);
    });
  }
});

test("Bun archive rejects a matching downloaded SHASUMS entry when the policy pin differs", () => {
  withFixture((root) => {
    binary(join(root, "node/bin/node"), "v26.10.0");
    binary(join(root, "node/bin/npm"), "10.1.0");
    binary(join(root, "node/bin/npx"), "10.1.0");
    const bundle = join(root, "ca-certificates.crt");
    writeFileSync(bundle, "fixture certificate bundle");
    const functions = runtimeFunctions().replaceAll(
      "/etc/ssl/certs/ca-certificates.crt",
      bundle,
    );
    const result = Bun.spawnSync(
      [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        `
fail() { exit 98; }
download_file() {
  if [[ "$1" == */SHASUMS256.txt ]]; then
    printf '%s  %s\n' "$(printf malicious | /usr/bin/sha256sum | cut -d ' ' -f1)" bun-linux-x64.zip > "$2"
  else
    printf malicious > "$2"
  fi
}
${functions}
install_runtimes
`,
      ],
      {
        env: {
          ...process.env,
          NODE_DIR: join(root, "node"),
          NODE_VERSION: "26.10.0",
          NODE_ARCH: "x64",
          NODE_SHA256: archivePins(policy.nodeArchiveSha256, "26.10.0").amd64,
          BUN_DIR: join(root, "bun"),
          BUN_VERSION: policy.bun,
          BUN_ARCH: "x64",
          BUN_SHA256: archivePins(policy.bunArchiveSha256, policy.bun).amd64,
        },
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("checksum did NOT match");
  });
});

test("runtime scratch is removed when download, verification or extraction exits under errexit", () => {
  for (const phase of ["download", "checksum", "extraction"] as const) {
    withFixture((root) => {
      binary(join(root, "node/bin/node"), "v26.10.0");
      // An interrupted extraction left node executable but no npm/npx.
      const bundle = join(root, "ca-certificates.crt");
      writeFileSync(bundle, "fixture certificate bundle");
      const functions = runtimeFunctions().replaceAll(
        "/etc/ssl/certs/ca-certificates.crt",
        bundle,
      );
      const result = Bun.spawnSync(
        [
          "bash",
          "-euo",
          "pipefail",
          "-c",
          `
fail() { exit 98; }
apt_refresh_for() { :; }
apt_install() { :; }
ldconfig() { printf '%s\\n' libatomic.so.1; }
mktemp() {
  local directory
  directory="$(command mktemp -d "$FIXTURE/scratch.XXXXXX")"
  printf '%s' "$directory" > "$FIXTURE/scratch-marker"
  printf '%s\\n' "$directory"
}
download_file() {
  [[ "$PHASE" != download ]] || return 73
  printf '%s\\n' 'fixture node-v26.10.0-linux-x64.tar.xz' > "$2"
}
sha256sum() { [[ "$PHASE" != checksum ]] || return 74; cat >/dev/null; }
tar() { [[ "$PHASE" != extraction ]] || return 75; return 97; }
ln() { exit 96; }
${functions}
install_runtimes
printf '%s\\n' unreachable
`,
        ],
        {
          env: {
            ...process.env,
            FIXTURE: root,
            PHASE: phase,
            NODE_DIR: join(root, "node"),
            NODE_VERSION: "26.10.0",
            NODE_ARCH: "x64",
            NODE_SHA256: archivePins(policy.nodeArchiveSha256, "26.10.0").amd64,
            BUN_DIR: join(root, "bun"),
            BUN_VERSION: policy.bun,
            BUN_ARCH: "x64",
            BUN_SHA256: archivePins(policy.bunArchiveSha256, policy.bun).amd64,
          },
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(
        { download: 73, checksum: 74, extraction: 75 }[phase],
      );
      expect(result.stdout.toString()).not.toContain("unreachable");
      const scratch = readFileSync(join(root, "scratch-marker"), "utf8");
      expect(existsSync(scratch)).toBe(false);
      expect(
        readdirSync(root).filter((entry) => entry.startsWith("scratch.")),
      ).toEqual([]);
    });
  }
});

test("runtime bootstrap repairs trust offline before any apt or runtime network request", () => {
  for (const rust of [false, true]) {
    for (const initial of ["missing", "empty", "populated"] as const) {
      const outcomes =
        initial === "populated"
          ? ["unchanged"]
          : ["repaired", "failed", "unchanged", "unavailable"];
      for (const outcome of outcomes) {
        withFixture((root) => {
          const bundle = join(root, "ca-certificates.crt");
          if (initial !== "missing")
            writeFileSync(
              bundle,
              initial === "empty" ? "" : "fixture certificate bundle",
            );
          const functions = runtimeFunctions(rust);
          expect(functions).toContain(
            "[[ ! -s /etc/ssl/certs/ca-certificates.crt ]]",
          );
          const rewritten = functions.replaceAll(
            "/etc/ssl/certs/ca-certificates.crt",
            bundle,
          );
          const marker = join(root, "apt-calls");
          const download = join(root, "download-attempt");
          const result = Bun.spawnSync(
            [
              "bash",
              "-euo",
              "pipefail",
              "-c",
              `
fail() { printf '%s\\n' "$*" >&2; exit 1; }
command() {
  if [[ "$1" == -v ]]; then
    # Force dependency setup even when certificate repair succeeds.
    [[ "$2" != curl ]] || return 1
    [[ "$2" != update-ca-certificates || "$OUTCOME" != unavailable ]] || return 1
    return 0
  fi
  builtin command "$@"
}
ldconfig() { printf '%s\\n' libatomic.so.1; }
apt_refresh_for() {
  [[ -s "$BUNDLE" ]] || return 96
  printf '%s\\n' "refresh $*" >> "$MARKER"
}
# Installing current packages is a no-op, so it cannot bootstrap TLS trust.
apt_install() {
  [[ -s "$BUNDLE" ]] || return 96
  printf '%s\\n' "install $*" >> "$MARKER"
}
update-ca-certificates() {
  printf '%s\\n' update >> "$MARKER"
  case "$OUTCOME" in
    repaired) printf '%s\\n' 'fixture rebuilt bundle' > "$BUNDLE" ;;
    failed) return 74 ;;
    unchanged) : ;;
  esac
}
mktemp() { command mktemp -d "$FIXTURE/scratch.XXXXXX"; }
download_file() {
  printf '%s\\n' attempted >> "$DOWNLOAD_MARKER"
  [[ -s "$BUNDLE" ]] || return 97
  return 93
}
${rewritten}
install_runtimes
`,
            ],
            {
              env: {
                ...process.env,
                MARKER: marker,
                BUNDLE: bundle,
                OUTCOME: outcome,
                FIXTURE: root,
                DOWNLOAD_MARKER: download,
                NODE_DIR: join(root, "node"),
                NODE_VERSION: "26.10.0",
                NODE_ARCH: "x64",
                BUN_DIR: join(root, "bun"),
                BUN_VERSION: policy.bun,
                BUN_ARCH: "x64",
              },
            },
          );
          const ready = initial === "populated" || outcome === "repaired";
          expect(result.exitCode, result.stderr.toString()).toBe(
            ready ? 93 : 1,
          );
          expect(existsSync(download)).toBe(ready);
          expect(result.stdout.toString()).toBe("");
          const packages =
            "ca-certificates curl unzip xz-utils openssl gnupg util-linux libatomic1";
          let expectedCalls = "update\n";
          if (outcome === "unavailable") expectedCalls = "";
          if (ready) {
            const repair = initial === "populated" ? "" : "update\n";
            expectedCalls = `${repair}refresh ${packages}\ninstall ${packages}\n`;
          }
          expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe(
            expectedCalls,
          );
          if (!ready) {
            expect(result.stderr.toString()).toContain("base image");
            expect(result.stderr.toString()).toContain("offline");
            expect(
              readdirSync(root).some((name) => name.startsWith("scratch.")),
            ).toBe(false);
          }
        });
      }
    }
  }
});
