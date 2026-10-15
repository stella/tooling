/// <reference types="bun-types" />
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderCloudNetwork } from "./cloud-setup-network";

const run = (body: string, env: Record<string, string> = {}) =>
  Bun.spawnSync(
    [
      "bash",
      "-eu",
      "-c",
      `fail() { echo "$*" >&2; exit 1; }\n${renderCloudNetwork()}\n${body}`,
    ],
    {
      env: { ...process.env, ...env },
    },
  );

test("downloads bind connection, transfer, retries and total elapsed time", () => {
  const result = run(`
timeout() { printf 'deadline:%s\\n' "$*"; shift 3; "$@"; }
curl() { printf 'curl:%s\\n' "$*"; }
download_file https://nodejs.org/dist/v26.10.0/SHASUMS256.txt /tmp/sums 45
`);
  expect(result.exitCode).toBe(0);
  const output = result.stdout.toString();
  expect(output).toContain("deadline:--signal=TERM --kill-after=5s 45s curl");
  expect(output).toContain(
    "--connect-timeout 20 --max-time 45 --retry 3 --retry-all-errors --retry-max-time 45",
  );
});

test("deadline and transfer timeout failures identify the download host", () => {
  for (const status of [28, 124, 137]) {
    const result = run(
      `timeout() { return ${status}; }; download_file https://static.rust-lang.org/rustup/archive/1.29.1/rustup-init /tmp/init 120`,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "download timed out: static.rust-lang.org",
    );
  }
  expect(
    run(
      "timeout() { return 22; }; download_file https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux-x64.zip /tmp/bun 120",
    ).exitCode,
  ).toBe(22);
});

test("APT deadlines name configured hosts and bind Acquire retries", () => {
  const result = run(`
apt-get() {
  if [[ "$*" == '--print-uris update' ]]; then
    printf "'http://archive.ubuntu.com/ubuntu/dists/noble/InRelease' file 0\\n'https://apt.postgresql.org/pub/repos/apt/dists/noble-pgdg/InRelease' file 0\\n"
  else
    printf '%s\\n' "$*"
  fi
}
timeout() { printf 'deadline:%s\\n' "$*"; shift 3; "$@"; }
apt_network update
`);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(
    "180s apt-get -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update",
  );
  const failure = run(
    `apt-get() { printf "'http://archive.ubuntu.com/ubuntu/dists/noble/InRelease' file 0\\n'https://apt.postgresql.org/pub/repos/apt/dists/noble-pgdg/InRelease' file 0\\n"; }; timeout() { return 124; }; apt_network install curl`,
  );
  expect(failure.stderr.toString()).toContain(
    "download timed out: archive.ubuntu.com,apt.postgresql.org",
  );
});

test("APT native timeout failures name configured hosts while other status 100 failures retain their status", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-network-test-"));
  try {
    const cases = [
      {
        status: "100",
        error: "Connection timed out [IP: 127.0.0.1 443]",
        timeout: true,
      },
      { status: "100", error: "CONNECTION TIMEOUT", timeout: true },
      { status: "100", error: "Timeout was reached", timeout: true },
      {
        status: "100",
        error: "E: Repository is unsigned; Acquire::http::Timeout=20",
        timeout: false,
      },
      { status: "0", error: "APT complete", timeout: false },
    ] as const;
    for (const scenario of cases) {
      const result = run(
        `
mktemp() { command mktemp "$FIXTURE_DIRECTORY/network.XXXXXX"; }
apt-get() {
  if [[ "$*" == '--print-uris update' ]]; then
    printf "'http://archive.ubuntu.com/ubuntu/dists/noble/InRelease' file 0\\n'https://user:private-value@apt.postgresql.org/pub/repos/apt/dists/noble-pgdg/InRelease' file 0\\n"
    return 0
  fi
  printf 'package progress\\n'
  printf '%s\\n' "$FIXTURE_ERROR" >&2
  return "$FIXTURE_STATUS"
}
timeout() { shift 3; "$@"; }
apt_network update
`,
        {
          FIXTURE_DIRECTORY: directory,
          FIXTURE_ERROR: scenario.error,
          FIXTURE_STATUS: scenario.status,
        },
      );
      expect(result.exitCode).toBe(
        scenario.timeout ? 1 : Number(scenario.status),
      );
      expect(result.stdout.toString()).toBe(
        `package progress\n${scenario.error}\n`,
      );
      expect(result.stderr.toString()).toBe(
        scenario.timeout
          ? "download timed out: archive.ubuntu.com,apt.postgresql.org\n"
          : "",
      );
      expect(result.stderr.toString()).not.toContain("private-value");
      expect(readdirSync(directory)).toEqual([]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native Bun and Rustup timeout wording is classified independently of their exit status", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-network-test-"));
  try {
    for (const error of [
      "error: Socket timeout",
      "error: operation timed out",
    ]) {
      const result = run(
        `
mktemp() { command mktemp "$FIXTURE_DIRECTORY/network.XXXXXX"; }
timeout() { printf '%s\\n' "$FIXTURE_ERROR" >&2; return 1; }
network_run registry.npmjs.org,static.rust-lang.org 180 fixture-command
`,
        { FIXTURE_DIRECTORY: directory, FIXTURE_ERROR: error },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe(`${error}\n`);
      expect(result.stderr.toString()).toBe(
        "download timed out: registry.npmjs.org,static.rust-lang.org\n",
      );
      expect(readdirSync(directory)).toEqual([]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("network logs are removed after outer deadlines and capture failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-network-test-"));
  try {
    for (const failure of ["deadline", "capture"] as const) {
      const result = run(
        `
mktemp() { command mktemp "$FIXTURE_DIRECTORY/network.XXXXXX"; }
timeout() { [[ "$FIXTURE_FAILURE" != deadline ]] || return 124; printf 'complete\\n'; }
tee() { if [[ "$FIXTURE_FAILURE" == capture ]]; then command cat >/dev/null; return 23; fi; command tee "$@"; }
network_run github.com 120 fixture-command
`,
        { FIXTURE_DIRECTORY: directory, FIXTURE_FAILURE: failure },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toBe(
        failure === "deadline"
          ? "download timed out: github.com\n"
          : "Cannot capture network command output\n",
      );
      expect(readdirSync(directory)).toEqual([]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("APT refreshes indexes unless the install downloads nothing", () => {
  const stub = (uris: string, status: number, network = "printf 'refresh:%s\\n' \"$*\"") => `
apt-get() {
  [[ "$1" == --print-uris && "$2" == -qq && "$3" == -y ]] || exit 91
  printf '%b' '${uris}'
  return ${status}
}
apt_network() { ${network}; }
apt_refresh_for curl ./valkey-server.deb
echo after
`;
  const nothing = run(stub("", 0));
  expect(nothing.exitCode).toBe(0);
  expect(nothing.stdout.toString()).toBe("after\n");
  // Cached indexes resolve, but the install would download: a stale index
  // could name a file the mirror no longer serves, so refresh first.
  const downloads = run(
    stub("http://archive.ubuntu.com/ubuntu/pool/main/c/curl/curl.deb curl.deb 1 SHA256:00\\n", 0),
  );
  expect(downloads.exitCode).toBe(0);
  expect(downloads.stdout.toString()).toBe("refresh:update\nafter\n");
  const unresolved = run(stub("", 100));
  expect(unresolved.exitCode).toBe(0);
  expect(unresolved.stdout.toString()).toBe("refresh:update\nafter\n");
  const failed = run(stub("", 100, "return 7"));
  expect(failed.exitCode).not.toBe(0);
  expect(failed.stdout.toString()).toBe("");
});
