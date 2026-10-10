/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import {
  existsSync,
  statSync,
  readFileSync,
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
    "current_setting('unix_socket_directories')",
    "--set=unix_socket_directories=",
    "-c unix_socket_directories=",
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

const processHelpers = () => {
  const fragment = renderCloudServiceStart({
    services: [...cloudServices],
    ...policy,
  });
  return ["service_process_matches", "service_process", "service_prune_pid"]
    .map((name) => {
      const start = fragment.indexOf(`\n${name}() {`);
      const end = fragment.indexOf("\n}\n", start);
      if (start < 0 || end < start)
        throw new Error(`Missing emitted ${name} boundary`);
      return fragment.slice(start, end + 3);
    })
    .join("\n");
};

type ProcessFixtureOptions = {
  root: string;
  body: string;
  procUid?: string;
  procExecutable?: string;
  resolution?: string;
};
const processFixture = ({
  root,
  body,
  procUid = "1000",
  procExecutable = "/managed-service",
  resolution = "resolved",
}: ProcessFixtureOptions) => {
  const helpers = processHelpers().replaceAll("/proc/", `${root}/proc/`);
  return Bun.spawnSync(
    [
      "bash",
      "-eu",
      "-c",
      `
fail() { echo "$*" >&2; exit 93; }
kill() { fail 'Unexpected process signal'; }
service_run() { fail 'Unexpected service launch'; }
SERVICE_UID=1000
stat() {
  [[ "$#" == 3 && "$1" == -c && "$2" == '%u' && "$3" == "$FIXTURE_ROOT/proc/123" ]] || fail 'Unexpected ownership query'
  [[ "$RESOLUTION" != owner-unavailable ]] || return 1
  printf '%s' "$PROC_UID"
}
readlink() {
  [[ "$#" == 2 && "$1" == -f ]] || fail 'Unexpected executable query'
  [[ "$RESOLUTION" != unresolved ]] || return 1
  [[ "$RESOLUTION" != empty ]] || return 0
  case "$2" in
    "$FIXTURE_ROOT/proc/123/exe")
      if [[ "$RESOLUTION" == deleted ]]; then printf '%s (deleted)' "$PROC_EXECUTABLE"; else printf '%s' "$PROC_EXECUTABLE"; fi ;;
    /managed-service) printf '/managed-service' ;;
    *) fail 'Unexpected executable path' ;;
  esac
}
root() {
  if [[ "$#" == 3 && "$1" == rm && "$2" == -- && "$3" == "$PID_FILE" ]]; then
    command rm -- "$3"
  elif [[ "$#" == 4 && "$1" == sed && "$2" == -i && "$3" == "1s/.*/$$/" && "$4" == "$PID_FILE" ]]; then
    # Apply only the requested first-row replacement; all other rows stay intact.
    command tail -n +2 -- "$PID_FILE" > "$FIXTURE_ROOT/remaining"
    printf '%s\n' "$$" > "$PID_FILE"
    command cat "$FIXTURE_ROOT/remaining" >> "$PID_FILE"
  else fail 'Unexpected root operation'; fi
}
${helpers}
${body}`,
    ],
    {
      env: {
        ...process.env,
        FIXTURE_ROOT: root,
        PROC_UID: procUid,
        PROC_EXECUTABLE: procExecutable,
        RESOLUTION: resolution,
      },
    },
  );
};

test("emitted process predicate is nonfatal for dead, foreign and unresolvable processes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cloud-process-test-"));
  try {
    mkdirSync(path.join(root, "proc/123"), { recursive: true });
    const cases = [
      {
        pid: "124",
        procUid: "1000",
        procExecutable: "/managed-service",
        resolution: "resolved",
        expected: "1",
      },
      {
        pid: "123",
        procUid: "999",
        procExecutable: "/managed-service",
        resolution: "resolved",
        expected: "1",
      },
      {
        pid: "123",
        procUid: "1000",
        procExecutable: "/unrelated-service",
        resolution: "resolved",
        expected: "1",
      },
      {
        pid: "123",
        procUid: "1000",
        procExecutable: "/managed-service",
        resolution: "unresolved",
        expected: "2",
      },
      ...["empty", "deleted", "owner-unavailable"].map((resolution) => ({
        pid: "123",
        procUid: "1000",
        procExecutable: "/managed-service",
        resolution,
        expected: "2",
      })),
      {
        pid: "123",
        procUid: "1000",
        procExecutable: "/managed-service",
        resolution: "resolved",
        expected: "0",
      },
    ];
    for (const scenario of cases) {
      const result = processFixture({
        root,
        procUid: scenario.procUid,
        procExecutable: scenario.procExecutable,
        resolution: scenario.resolution,
        body: `identity=0\nservice_process_matches ${scenario.pid} /managed-service || identity="$?"\nprintf '%s\\n' "$identity"\necho continued`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString()).toBe(
        `${scenario.expected}\ncontinued\n`,
      );
    }
    const asserted = processFixture({
      root,
      procUid: "999",
      body: "service_process 123 /managed-service",
    });
    expect(asserted.exitCode).toBe(93);
    expect(asserted.stderr.toString()).toContain("Managed service process");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!existsSync("/proc/self/exe"))(
  "emitted predicate leaves an unrelated live Linux process untouched",
  () => {
    const helpers = processHelpers();
    const result = Bun.spawnSync(
      [
        "bash",
        "-eu",
        "-c",
        `
fail() { echo "$*" >&2; exit 93; }
kill() { fail 'Unexpected process signal'; }
SERVICE_UID="$(id -u)"
${helpers}
if service_process_matches "$LIVE_PID" "$LIVE_EXECUTABLE"; then echo matches; else echo different; fi
if service_process_matches "$LIVE_PID" /bin/sh; then echo matches; else echo different; fi
SERVICE_UID="$((SERVICE_UID + 1))"
if service_process_matches "$LIVE_PID" "$LIVE_EXECUTABLE"; then echo matches; else echo different; fi
[[ -d "/proc/$LIVE_PID" ]] || fail 'Live process disappeared'`,
      ],
      {
        env: {
          ...process.env,
          LIVE_PID: String(process.pid),
          LIVE_EXECUTABLE: process.execPath,
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toBe("matches\ndifferent\ndifferent\n");
  },
);

test("emitted PID recovery preserves PostgreSQL lock metadata and rejects unobservable identities", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cloud-pid-test-"));
  try {
    mkdirSync(path.join(root, "proc/123"), { recursive: true });
    const sentinel = path.join(root, "unrelated");
    writeFileSync(sentinel, "unchanged");
    for (const service of cloudServices) {
      const stale = service === "postgres" ? "rewritten" : "removed";
      const cases = [
        {
          pid: "123",
          procUid: "1000",
          procExecutable: "/managed-service",
          resolution: "resolved",
          expected: "preserved",
        },
        {
          pid: "123",
          procUid: "999",
          procExecutable: "/managed-service",
          resolution: "resolved",
          expected: stale,
        },
        {
          pid: "123",
          procUid: "1000",
          procExecutable: "/unrelated-service",
          resolution: "resolved",
          expected: stale,
        },
        {
          pid: "124",
          procUid: "1000",
          procExecutable: "/managed-service",
          resolution: "resolved",
          expected: service === "postgres" ? "preserved" : "removed",
        },
        {
          pid: "invalid",
          procUid: "1000",
          procExecutable: "/managed-service",
          resolution: "resolved",
          expected: service === "postgres" ? "rejected" : "removed",
        },
        ...["unresolved", "empty", "deleted", "owner-unavailable"].map(
          (resolution) => ({
            pid: "123",
            procUid: "1000",
            procExecutable: "/managed-service",
            resolution,
            expected: "rejected",
          }),
        ),
      ];
      if (service === "postgres")
        cases.push({
          pid: "-123",
          procUid: "1000",
          procExecutable: "/managed-service",
          resolution: "resolved",
          expected: "preserved",
        });
      for (const scenario of cases) {
        const file = path.join(root, `${service}.pid`);
        const rows =
          service === "postgres"
            ? `${root}/data\n1700000000\n55432\n\n127.0.0.1\n123 456\nready\n`
            : "";
        const original = `${scenario.pid}\n${rows}`;
        writeFileSync(file, original, { mode: 0o600 });
        const previous = statSync(file);
        const result = processFixture({
          root,
          procUid: scenario.procUid,
          procExecutable: scenario.procExecutable,
          resolution: scenario.resolution,
          body: `PID_FILE="$FIXTURE_ROOT/${service}.pid"\nservice_prune_pid "$PID_FILE" /managed-service ${service}\nprintf 'controller:%s\\n' "$$"`,
        });
        expect(result.exitCode).toBe(scenario.expected === "rejected" ? 93 : 0);
        if (scenario.expected === "rejected")
          expect(result.stderr.toString()).toMatch(
            /Cannot verify|Cannot safely recover/,
          );
        else expect(result.stderr.toString()).toBe("");
        expect(existsSync(file)).toBe(scenario.expected !== "removed");
        if (scenario.expected === "rewritten") {
          const controller = /controller:(\d+)\n$/
            .exec(result.stdout.toString())
            ?.at(1);
          expect(controller).toBeDefined();
          expect(controller).not.toBe(scenario.pid);
          expect(readFileSync(file, "utf8")).toBe(`${controller}\n${rows}`);
        } else if (scenario.expected !== "removed")
          expect(readFileSync(file, "utf8")).toBe(original);
        if (existsSync(file)) {
          const current = statSync(file);
          expect([current.uid, current.gid, current.mode]).toEqual([
            previous.uid,
            previous.gid,
            previous.mode,
          ]);
        }
        expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
