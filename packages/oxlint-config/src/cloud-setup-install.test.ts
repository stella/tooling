/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import policy from "../toolchain.json";
import { renderCloudServiceInstall } from "./cloud-setup-install";
import { parseToolchainPolicy } from "./toolchain-schema";

const fragment = renderCloudServiceInstall({
  ...parseToolchainPolicy(policy),
  services: [],
})
  .replaceAll("/var/lock/stll-cloud-apt.lock", '"$FIXTURE_LOCK"')
  .replaceAll("/usr/sbin/policy-rc.d", '"$FIXTURE_POLICY"');

const runInstall = (directory: string, exitCode: number) => {
  expect(fragment).not.toContain("/var/lock/");
  expect(fragment).not.toContain("/usr/sbin/");
  return Bun.spawnSync(
    [
      "bash",
      "-eu",
      "-c",
      `
fail() { printf '%s\\n' "$1" >&2; exit 1; }
flock() { [[ "$*" == '-x -w 120 8' ]]; }
apt-get() {
  [[ "$DEBIAN_FRONTEND" == noninteractive ]]
  [[ "$(cat "$FIXTURE_POLICY")" == $'#!/bin/sh\\nexit 101' ]]
  [[ -x "$FIXTURE_POLICY" ]]
  printf '%s' "$*" > "$FIXTURE_CALLS"
  return "$FIXTURE_EXIT"
}
${fragment}
apt_install fixture-package
`,
    ],
    {
      env: {
        ...process.env,
        TMPDIR: directory,
        FIXTURE_POLICY: join(directory, "policy-rc.d"),
        FIXTURE_LOCK: join(directory, "apt.lock"),
        FIXTURE_CALLS: join(directory, "apt.calls"),
        FIXTURE_EXIT: String(exitCode),
      },
    },
  );
};

test("package installation restores policy bytes and mode across success and failure", () => {
  const original = "#!/bin/sh\n# Existing host policy\nexit 0\n";
  for (const exitCode of [0, 17]) {
    for (const existing of [true, false]) {
      const directory = mkdtempSync(join(tmpdir(), "cloud-apt-test-"));
      try {
        const file = join(directory, "policy-rc.d");
        if (existing) writeFileSync(file, original, { mode: 0o640 });
        const result = runInstall(directory, exitCode);
        expect(result.stderr.toString()).toBe("");
        expect(result.exitCode).toBe(exitCode);
        expect(readFileSync(join(directory, "apt.calls"), "utf8")).toBe(
          "install -y --no-install-recommends fixture-package",
        );
        expect(existsSync(file)).toBe(existing);
        if (existing) {
          expect(readFileSync(file, "utf8")).toBe(original);
          expect(statSync(file).mode & 0o777).toBe(0o640);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
});

test("package installation refuses symlink policies before invoking apt", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-apt-test-"));
  try {
    const target = join(directory, "original");
    const file = join(directory, "policy-rc.d");
    writeFileSync(target, "original policy\n", { mode: 0o640 });
    symlinkSync(target, file);
    const result = runInstall(directory, 0);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Unsupported service-start policy symlink",
    );
    expect(existsSync(join(directory, "apt.calls"))).toBe(false);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("original policy\n");
    expect(statSync(target).mode & 0o777).toBe(0o640);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
