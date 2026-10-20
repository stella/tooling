/// <reference types="bun-types" />
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cloudShellProfilePath,
  renderCloudShellInstall,
  renderCloudShellProfile,
} from "./cloud-setup-shell";

const nodeVersion = "26.10.0";
const bunVersion = "1.4.3";
const managed = [
  `/opt/stll-cloud/node/${nodeVersion}/bin`,
  `/opt/stll-cloud/bun/${bunVersion}`,
  "/usr/local/bin",
];
const profile = renderCloudShellProfile({
  nodeVersion,
  bunVersion,
  rust: undefined,
});

test("managed PATH prepending is an idempotent projection that preserves every unrelated entry", () => {
  const entries = [
    "",
    "/usr/bin",
    "/opt/old-bun",
    "/opt/old-node",
    "/tmp/space dir",
    "/tmp/$literal",
    "/tmp/'quote",
    ...managed,
  ];
  let seed = 12345;
  for (let sample = 0; sample < 100; sample++) {
    const path = [];
    for (let index = 0; index < 1 + (sample % 9); index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const entry = entries.at(seed % entries.length);
      if (entry === undefined) throw new Error("PATH fixture index absent");
      path.push(entry);
    }
    const expected = [
      ...managed,
      ...path.filter((entry) => !managed.includes(entry)),
    ].join(":");
    const result = Bun.spawnSync(
      [
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        `${profile}\nfirst="$PATH"\n${profile}\n[[ "$first" == "$PATH" ]] || exit 1\nprintf '%s' "$PATH"`,
      ],
      { env: { ...process.env, PATH: path.join(":") } },
    );
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(expected);
  }
}, 15_000);

test("shell environment installation cleans its temporary file and preserves startup failure status", () => {
  for (const status of [0, 73, 124]) {
    const directory = mkdtempSync(join(tmpdir(), "cloud-shell-cleanup-"));
    try {
      const destination = join(directory, "profile.sh");
      const temporary = join(directory, "temporary");
      const rendered = renderCloudShellInstall({
        nodeVersion,
        bunVersion,
        rust: undefined,
      }).replaceAll(cloudShellProfilePath, destination);
      const result = Bun.spawnSync(
        [
          "/bin/bash",
          "-euo",
          "pipefail",
          "-c",
          `
        fail() { printf '%s\\n' "$*" >&2; exit 1; }
        mktemp() { printf '' > "$FIXTURE_TEMPORARY"; printf '%s' "$FIXTURE_TEMPORARY"; }
        install() { [[ "$1" == -m && "$2" == 644 ]] || return 90; cp "$3" "$4"; }
        runuser() { return "$FIXTURE_STATUS"; }
        ${rendered}
        install_shell_environment
      `,
        ],
        {
          env: {
            ...process.env,
            OUTPUT_USER: "fixture",
            OUTPUT_HOME: directory,
            FIXTURE_STATUS: String(status),
            FIXTURE_TEMPORARY: temporary,
          },
        },
      );
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(status);
      expect(existsSync(temporary)).toBe(false);
      expect(readFileSync(destination, "utf8")).toBe(profile);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 15_000);
