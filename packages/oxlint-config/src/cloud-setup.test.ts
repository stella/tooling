/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import policyInput from "../toolchain.json";
import { cloudEnvironmentMarker, generateCloudSetup } from "./cloud-setup";
import {
  cloudInstallCommand,
  cloudServices,
  parseCloudSetup,
} from "./cloud-setup-schema";
import { parseToolchainPolicy } from "./toolchain-schema";

const policy = parseToolchainPolicy(policyInput);
const generate = (input: unknown, nodeVersion = "26.10.0") => {
  const cloud = parseCloudSetup(input);
  if (cloud === undefined) throw new Error("Missing cloud declaration");
  return generateCloudSetup({ policy, cloud, nodeVersion });
};
const declaration = {
  services: [],
  install: cloudInstallCommand,
  envFile: ".env.cloud",
};

test("generated script rejects missing or unknown modes before platform checks", () => {
  const generated = generate(declaration);
  for (const args of [[], ["unknown"], ["--help"], ["install", "start"]]) {
    const result = Bun.spawnSync(["bash", "-s", "--", ...args], {
      stdin: Buffer.from(generated),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(
      "Usage: cloud-setup.sh install|start\n",
    );
  }
});

const environmentParts = (generated: string) => {
  const assignment = /^ENV_FILE=.*$/m.exec(generated)?.at(0);
  const marker = /^ENV_MARKER=.*$/m.exec(generated)?.at(0);
  const start = generated.indexOf("\nvalidate_environment() {");
  const end = generated.indexOf('\nif [[ "$MODE" == install ]]; then', start);
  if (
    assignment === undefined ||
    marker === undefined ||
    start < 0 ||
    end <= start
  )
    throw new Error(
      "Missing emitted environment assignment or function boundary",
    );
  return { assignment, marker, functions: generated.slice(start, end) };
};

const withRepository = (run: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "cloud-environment-test-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const environmentRun = ({
  root,
  generated,
  command,
}: {
  root: string;
  generated: string;
  command: string;
}) => {
  const { assignment, marker, functions } = environmentParts(generated);
  return Bun.spawnSync(
    [
      "bash",
      "-eu",
      "-c",
      `fail() { echo "$*" >&2; exit 1; }
OUTPUT_UID="$(id -u)"
OUTPUT_GID="$(id -g)"
DATABASE_URL='postgresql://local-test@127.0.0.1:55432/test'
REDIS_URL='redis://local-test@127.0.0.1:56379/0'
${assignment}
${marker}
${functions}
${command}`,
    ],
    { cwd: root, env: { ...process.env, REPO_ROOT: root } },
  );
};

test("all service subsets generate deterministic valid Bash regardless of declaration order", () => {
  for (let mask = 0; mask < 2 ** cloudServices.length; mask += 1) {
    const services = cloudServices.filter(
      (_, index) => (mask & (1 << index)) !== 0,
    );
    const generated = generate({ ...declaration, services });
    expect(generate({ ...declaration, services })).toBe(generated);
    expect(generate({ ...declaration, services: services.toReversed() })).toBe(
      generated,
    );
    const syntax = Bun.spawnSync(["bash", "-n"], {
      stdin: Buffer.from(generated),
    });
    expect(syntax.exitCode).toBe(0);
    expect(syntax.stderr.toString()).toBe("");
    expect(generated).not.toMatch(/\.s\.PGSQL|\s-k\s|\bunixsocket\s/);
    const sockets = [
      ...generated.matchAll(/unix_socket_directories=([^\s"']*)/g),
    ];
    expect(sockets.length).toBe(services.includes("postgres") ? 2 : 0);
    for (const socket of sockets) expect(socket.at(1)).toBe("");
    for (const line of generated.split("\n")) {
      if (
        line.includes('"$pg_bin/psql"') ||
        line.includes('"$pg_bin/createdb"')
      )
        expect(line).toContain("-h 127.0.0.1 -p 55432");
      if (
        line.includes('"$pg_bin/initdb"') ||
        line.includes('"$pg_bin/pg_ctl"')
      )
        expect(line).toContain("PGHOST=127.0.0.1 PGHOSTADDR=127.0.0.1");
    }
    for (const service of cloudServices) {
      const marker = service === "postgres" ? "pg_ctl" : "valkey-server";
      expect(generated.includes(marker)).toBe(services.includes(service));
    }
  }
});

test("cloud generation rejects every nonexact or out-of-series Node selector", () => {
  expect(generate(declaration, "26.10.0\n")).toContain(
    "NODE_VERSION='26.10.0'",
  );
  for (const nodeVersion of [
    "",
    "26",
    "26.x",
    "26.10",
    "v26.10.0",
    "026.10.0",
    "26.10.0-rc.1",
    "26.10.0+meta",
    "24.15.0",
    "latest",
    "^26.10.0",
    "26.10.0; true",
    "26.10.0\n26.11.0",
  ])
    expect(() => generate(declaration, nodeVersion)).toThrow(
      "exact .node-version",
    );
});

test("shell quoting preserves canonical literal metacharacters through single-pass replacement", () => {
  withRepository((root) => {
    const envFile = ".env'\"$`@SERVICE_INSTALL@";
    const generated = generate({ ...declaration, envFile });
    const syntax = Bun.spawnSync(["bash", "-n"], {
      stdin: Buffer.from(generated),
    });
    expect(syntax.exitCode).toBe(0);
    const result = environmentRun({
      root,
      generated,
      command: 'printf "%s" "$ENV_FILE"',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(envFile);
  });
});

test("actual emitted environment functions write owned files idempotently with private permissions", () => {
  withRepository((root) => {
    mkdirSync(join(root, "config"));
    const generated = generate({
      ...declaration,
      envFile: "config/.env.cloud",
    });
    const file = join(root, "config/.env.cloud");
    const first = environmentRun({
      root,
      generated,
      command: "write_environment",
    });
    expect(first.exitCode).toBe(0);
    const content = readFileSync(file, "utf8");
    expect(content).toBe(
      `${cloudEnvironmentMarker}\nNODE_ENV=test\nDATABASE_URL=postgresql://local-test@127.0.0.1:55432/test\nREDIS_URL=redis://local-test@127.0.0.1:56379/0\n`,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(
      environmentRun({ root, generated, command: "write_environment" })
        .exitCode,
    ).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(content);
  });
});

test("actual emitted environment validation refuses unowned files, symlinks and missing parents", () => {
  withRepository((root) => {
    const outside = mkdtempSync(join(tmpdir(), "cloud-environment-outside-"));
    try {
      const sentinel = join(outside, "sentinel");
      writeFileSync(sentinel, "unchanged\n");
      writeFileSync(join(root, ".env.unowned"), "unowned\n");
      symlinkSync(sentinel, join(root, ".env.link"));
      symlinkSync(outside, join(root, "linked"), "dir");
      mkdirSync(join(root, ".env.directory"));
      for (const envFile of [
        ".env.unowned",
        ".env.link",
        "linked/sentinel",
        "missing/.env",
        ".env.directory",
      ]) {
        const generated = generate({ ...declaration, envFile });
        const result = environmentRun({
          root,
          generated,
          command: "write_environment",
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toMatch(
          /unowned|symbolic links|missing|regular file/,
        );
      }
      expect(readFileSync(sentinel, "utf8")).toBe("unchanged\n");
      expect(readFileSync(join(root, ".env.unowned"), "utf8")).toBe(
        "unowned\n",
      );
      expect(existsSync(join(root, "missing"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("dependency installation uses the invoking user, home, private cache and pinned frozen Bun", () => {
  withRepository((root) => {
    const generated = generate(declaration);
    const start = generated.indexOf("\ndependency_install() {");
    const closing = generated.indexOf("\n}\n", start);
    if (start < 0 || closing < start)
      throw new Error("Missing emitted dependency installer boundary");
    mkdirSync(join(root, "home"));
    const cacheParent = join(root, "cache");
    const helper = generated
      .slice(start, closing + 3)
      .replaceAll("/var/cache/stll-cloud", cacheParent);
    expect(helper).not.toMatch(/\b(?:curl|wget|apt-get|systemctl)\b/);
    const assignments = ["BUN_VERSION", "BUN_DIR", "NODE_VERSION", "NODE_DIR"]
      .map((name) => {
        const line = new RegExp(`^${name}=.*$`, "m").exec(generated)?.at(0);
        if (line === undefined) throw new Error(`Missing emitted ${name}`);
        return line;
      })
      .join("\n");
    const runtimePath = /^export PATH=.*$/m.exec(generated)?.at(0);
    if (runtimePath === undefined)
      throw new Error("Missing emitted runtime PATH");
    const result = Bun.spawnSync(
      [
        "bash",
        "-eu",
        "-c",
        `
fail() { echo "$*" >&2; exit 1; }
root() { fail 'Unexpected privileged command'; }
OUTPUT_UID=4242
OUTPUT_GID=4343
OUTPUT_USER=fixture-caller
OUTPUT_HOME="$FIXTURE_ROOT/home"
CACHE_PARENT="$FIXTURE_ROOT/cache"
BUN_CACHE="$CACHE_PARENT/bun/$OUTPUT_UID"
${assignments}
${runtimePath}
install() {
  [[ "$#" == 8 && "$1" == -d && "$2" == -m && "$4" == -o && "$6" == -g ]] || fail 'Unexpected provisioning arguments'
  if [[ "$8" == "$BUN_CACHE" ]]; then
    [[ "$3" == 700 && "$5" == "$OUTPUT_UID" && "$7" == "$OUTPUT_GID" ]] || fail 'Cache is not assigned to the caller'
  else
    [[ "$8" == "$CACHE_PARENT" || "$8" == "$CACHE_PARENT/bun" ]] || fail 'Unexpected cache parent'
    [[ "$3" == 755 && "$5" == root && "$7" == root ]] || fail 'Cache parent is not root-owned'
  fi
  command mkdir -p -- "$8"
}
stat() {
  [[ "$#" == 3 && "$1" == -c && "$2" == '%u' ]] || fail 'Unexpected ownership query'
  if [[ "$3" == "$BUN_CACHE" ]]; then printf '%s\n' "$OUTPUT_UID";
  elif [[ "$3" == "$CACHE_PARENT" || "$3" == "$CACHE_PARENT/bun" ]]; then printf '0\n';
  else fail 'Unexpected stat target'; fi
}
runuser() {
  [[ "$#" == 10 && "$1" == -u && "$2" == "$OUTPUT_USER" && "$3" == -- && "$4" == env ]] || fail 'Dependencies do not run as the caller'
  [[ "$5" == "HOME=$OUTPUT_HOME" && "$6" == "BUN_INSTALL_CACHE_DIR=$BUN_CACHE" && "$7" == "PATH=$NODE_DIR/bin:$BUN_DIR:/usr/local/bin:/usr/bin:/bin" ]] || fail 'Caller environment is missing'
  [[ "$8" == '/opt/stll-cloud/bun/${policy.bun}/bun' && "$9" == install ]] || fail 'Pinned install is missing'
  shift 9
  [[ "$1" == --frozen-lockfile ]] || fail 'Frozen install is missing'
  printf '%s:%s\n' "$OUTPUT_UID" "$OUTPUT_USER"
}
${helper}
dependency_install
dependency_install`,
      ],
      { cwd: root, env: { ...process.env, FIXTURE_ROOT: root } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toBe(
      "4242:fixture-caller\n4242:fixture-caller\n",
    );
    expect(existsSync(join(cacheParent, "bun/4242"))).toBe(true);
  });
});
