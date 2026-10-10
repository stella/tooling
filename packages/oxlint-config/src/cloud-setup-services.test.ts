/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { cloudServices } from "./cloud-setup-schema";
import { renderCloudServiceStart } from "./cloud-setup-services";

const policy = { postgres: "18", valkey: "9.1.1" };

test("all declared service subsets render deterministic valid Bash", () => {
  for (let mask = 0; mask < 2 ** cloudServices.length; mask += 1) {
    const services = cloudServices.filter(
      (_, index) => (mask & (1 << index)) !== 0,
    );
    const fragment = renderCloudServiceStart({ services, ...policy });
    expect(renderCloudServiceStart({ services, ...policy })).toBe(fragment);
    const checked = Bun.spawnSync(["bash", "-n"], {
      stdin: Buffer.from(fragment),
    });
    expect(checked.stderr.toString()).toBe("");
    expect(checked.exitCode).toBe(0);
    for (const service of cloudServices) {
      const marker = service === "postgres" ? "pg_ctl" : "valkey-server";
      expect(fragment.includes(marker)).toBe(services.includes(service));
    }
    expect(fragment).not.toMatch(/curl|wget|apt-get|systemctl|kill /);
  }
});

test("no declared services require no service state or commands", () => {
  const fragment = renderCloudServiceStart({ services: [], ...policy });
  const result = Bun.spawnSync([
    "bash",
    "-eu",
    "-c",
    `${fragment}\nstart_services`,
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("");
});

test("service policy parameters cannot introduce shell syntax", () => {
  for (const postgres of ["", "18.x", "18;true", "018"])
    expect(() =>
      renderCloudServiceStart({ services: [], ...policy, postgres }),
    ).toThrow();
  for (const valkey of ["", "9.1", "9.1.1;true", "9.1.1-rc"])
    expect(() =>
      renderCloudServiceStart({ services: [], ...policy, valkey }),
    ).toThrow();
});

test("PostgreSQL uses authenticated private state and checks endpoint identity", () => {
  const fragment = renderCloudServiceStart({
    services: ["postgres"],
    ...policy,
  });
  for (const required of [
    "--auth-host=scram-sha-256",
    "--auth-local=scram-sha-256",
    "--pwfile=",
    "-h 127.0.0.1 -p 55432",
    "-t 10 -w start",
    "current_setting('data_directory')",
    "current_setting('listen_addresses')",
    "pg_version / 10000 == 18",
    "service_process",
    "cloud_test",
    "DATABASE_URL=",
  ])
    expect(fragment).toContain(required);
  expect(fragment).not.toContain("--auth-local=trust");
});

test("Valkey verifies its own version and managed process rather than Redis compatibility", () => {
  const fragment = renderCloudServiceStart({ services: ["valkey"], ...policy });
  for (const required of [
    "valkey_version:9.1.1",
    "config_file:$vk_config",
    "process_id:$vk_pid",
    "protected-mode yes",
    "requirepass $vk_password",
    "CONFIG GET bind",
    "CONFIG GET dir",
    "timeout 0.2 valkey-cli",
    "attempt<20",
    "REDIS_URL=",
  ])
    expect(fragment).toContain(required);
  expect(fragment).not.toContain("redis_version:");
  expect(
    renderCloudServiceStart({
      services: ["valkey"],
      ...policy,
      valkey: "9.1.2",
    }),
  ).toContain("valkey_version:9.1.2");
});

test("symbolic service state is refused before any service command", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "cloud-service-test-"));
  try {
    mkdirSync(path.join(temporary, "target"));
    symlinkSync(path.join(temporary, "target"), path.join(temporary, "state"));
    const fragment = renderCloudServiceStart({
      services: [...cloudServices],
      ...policy,
    });
    const result = Bun.spawnSync(
      [
        "bash",
        "-eu",
        "-c",
        `
id() { printf '1000'; }
fail() { printf '%s\\n' "$1" >&2; exit 1; }
root() { printf 'unexpected root command' >&2; exit 90; }
service_run() { printf 'unexpected service command' >&2; exit 91; }
${fragment}
start_services
`,
      ],
      { env: { ...process.env, STATE: path.join(temporary, "state") } },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Invalid cloud service state directory",
    );
    expect(result.stderr.toString()).not.toContain("unexpected");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("cached Valkey configuration must match before a process can start", () => {
  const state = mkdtempSync(path.join(tmpdir(), "cloud-service-test-"));
  try {
    mkdirSync(path.join(state, "valkey"));
    writeFileSync(path.join(state, "valkey.password"), "a".repeat(64));
    writeFileSync(path.join(state, "valkey/valkey.conf"), "bind 0.0.0.0\n");
    const fragment = renderCloudServiceStart({
      services: ["valkey"],
      ...policy,
    });
    const result = Bun.spawnSync(
      [
        "bash",
        "-eu",
        "-c",
        `
id() { printf '1000'; }
stat() {
  case "$3" in
    "$STATE") printf '0';;
    "$STATE/valkey") printf '1000:700';;
    "$STATE/valkey.password") printf '0:600';;
    "$STATE/valkey/valkey.conf") printf '1000:600';;
    *) exit 92;;
  esac
}
fail() { printf '%s\\n' "$1" >&2; exit 1; }
root() { printf 'unexpected root command' >&2; exit 90; }
service_run() { printf 'unexpected service command' >&2; exit 91; }
${fragment}
start_services
`,
      ],
      { env: { ...process.env, STATE: state } },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Valkey configuration differs from managed settings",
    );
    expect(result.stderr.toString()).not.toContain("unexpected");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
