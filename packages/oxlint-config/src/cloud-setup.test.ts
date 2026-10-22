/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { cloudSetupArtifacts } from "./cloud-setup-artifacts";
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
  services: ["postgres"],
  install: cloudInstallCommand,
  envFile: ".env.cloud",
};
const postgresAndValkeyDeclaration = {
  ...declaration,
  services: ["postgres", "valkey"],
};

const wasmBindgenVersion = cloudSetupArtifacts["wasm-bindgen-cli"].version;
const wasmLock = (versions: readonly string[], development = "1.0.0") =>
  `version = 4\n\n[[package]]\nname = "development-only"\nversion = "${development}"\n\n${versions.map((version) => `[[package]]\nname = "wasm-bindgen"\nversion = "${version}"\n`).join("\n")}`;
const generateWasmSetup = (lock: string) => {
  const cloud = parseCloudSetup({
    install: cloudInstallCommand,
    tools: { "wasm-bindgen-cli": wasmBindgenVersion },
  });
  if (cloud === undefined) throw new Error("Missing cloud declaration");
  return generateCloudSetup({
    policy,
    cloud,
    nodeVersion: "26.10.0",
    files: { "Cargo.lock": lock },
  });
};

test("wasm-bindgen validation derives only the locked crate version", () => {
  const original = generateWasmSetup(wasmLock([wasmBindgenVersion]));
  const unrelatedUpdate = generateWasmSetup(
    wasmLock([wasmBindgenVersion], "2.0.0"),
  );
  expect(unrelatedUpdate).toBe(original);
  expect(original).not.toContain("sha256sum -- 'Cargo.lock'");

  const start = original.indexOf("[[ ! -e 'rust-toolchain.toml'");
  const end = original.indexOf('\n\nif [[ "$MODE" == install', start);
  if (start < 0 || end <= start)
    throw new Error("Missing generated input validation boundary");
  const validation = original.slice(start, end);
  const run = (lock: string | undefined) =>
    withRepository((root) => {
      if (lock !== undefined) writeFileSync(join(root, "Cargo.lock"), lock);
      return Bun.spawnSync(
        [
          "bash",
          "-eu",
          "-c",
          `fail() { echo "$*" >&2; exit 1; }\n${validation}`,
        ],
        { cwd: root },
      );
    });

  expect(run(wasmLock([wasmBindgenVersion])).exitCode).toBe(0);
  expect(run(wasmLock([wasmBindgenVersion, wasmBindgenVersion])).exitCode).toBe(
    0,
  );
  expect(
    run(
      `${wasmLock([wasmBindgenVersion])}\n[[patch.unused]]\nname = "wasm-bindgen"\nversion = "0.1.0"\n`,
    ).exitCode,
  ).toBe(0);
  expect(
    run(
      `${wasmLock([])}\n[[patch.unused]]\nname = "wasm-bindgen"\nversion = "${wasmBindgenVersion}"\n`,
    ).exitCode,
  ).toBe(1);
  expect(
    run(
      `${wasmLock([wasmBindgenVersion])}\n[metadata]\nname = "unrelated"\nversion = "0.1.0"\n`,
    ).exitCode,
  ).toBe(0);
  for (const lock of [
    wasmLock(["0.1.0"]),
    wasmLock([wasmBindgenVersion, "0.1.0"]),
    wasmLock([]),
    undefined,
  ]) {
    const result = run(lock);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Cargo.lock wasm-bindgen version changed; regenerate cloud-setup.sh",
    );
  }
  withRepository((root) => {
    const target = join(root, "outside.lock");
    writeFileSync(target, wasmLock([wasmBindgenVersion]));
    symlinkSync(target, join(root, "Cargo.lock"));
    const result = Bun.spawnSync(
      ["bash", "-eu", "-c", `fail() { echo "$*" >&2; exit 1; }\n${validation}`],
      { cwd: root },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Cargo.lock wasm-bindgen version changed; regenerate cloud-setup.sh",
    );
  });
}, 15_000);

test("generated lifecycle comments describe the portable phase contract", () => {
  const generated = generate(declaration);
  expect(generated).toContain(
    "# Networked installation and offline service startup",
  );
  expect(generated).toContain("run start at every session start");
  expect(generated).not.toMatch(/^#.*https?:\/\//m);
}, 15_000);

test("generated script rejects missing or unknown modes before platform checks", () => {
  const generated = generate(declaration);
  for (const args of [[], ["unknown"], ["--help"], ["install", "start"]]) {
    const result = Bun.spawnSync(["bash", "-s", "--", ...args], {
      stdin: Buffer.from(generated),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(
      "Usage: cloud-setup.sh install|start|session\n",
    );
  }
}, 15_000);

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

const withRepository = <Result>(run: (root: string) => Result): Result => {
  const root = mkdtempSync(join(tmpdir(), "cloud-environment-test-"));
  try {
    return run(root);
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
${assignment}
${marker}
${functions}
DATABASE_URL='postgresql://stll_cloud:fixture-secret@127.0.0.1:55432/cloud_test'
POSTGRES_HOST='127.0.0.1:55432'
POSTGRES_USER='stll_cloud'
POSTGRES_PASSWORD='fixture-secret'
POSTGRES_DB_NAME='cloud_test'
POSTGRES_ADDITIONAL_CONNECTION_DATA=''
REDIS_URL='redis://local-test@127.0.0.1:56379/0'
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
    const input =
      services.length === 0
        ? { services, install: cloudInstallCommand }
        : { ...declaration, services };
    const generated = generate(input);
    expect(generate(input)).toBe(generated);
    expect(generate({ ...input, services: services.toReversed() })).toBe(
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
}, 15_000);

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
}, 15_000);

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
}, 15_000);

test("actual emitted environment functions write owned files idempotently with private permissions", () => {
  withRepository((root) => {
    mkdirSync(join(root, "config"));
    const generated = generate({
      ...postgresAndValkeyDeclaration,
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
      `${cloudEnvironmentMarker}\nNODE_ENV=test\nDATABASE_URL=postgresql://stll_cloud:fixture-secret@127.0.0.1:55432/cloud_test\nPOSTGRES_HOST=127.0.0.1:55432\nPOSTGRES_USER=stll_cloud\nPOSTGRES_PASSWORD=fixture-secret\nPOSTGRES_DB_NAME=cloud_test\nPOSTGRES_ADDITIONAL_CONNECTION_DATA=\nREDIS_URL=redis://local-test@127.0.0.1:56379/0\n`,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(
      environmentRun({ root, generated, command: "write_environment" })
        .exitCode,
    ).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(content);
  });
}, 15_000);

test("session exports are shell-quoted projections of the generated service endpoints", () => {
  withRepository((root) => {
    mkdirSync(join(root, "config"));
    const generated = generate({
      ...postgresAndValkeyDeclaration,
      envFile: "config/.env.custom",
    });
    const result = environmentRun({
      root,
      generated,
      command: "write_environment && emit_session_environment",
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "config/.env.custom"), "utf8")).toContain(
      "POSTGRES_ADDITIONAL_CONNECTION_DATA=\n",
    );
    expect(result.stdout.toString()).toBe(
      "export NODE_ENV=test\n" +
        "export DATABASE_URL=postgresql://stll_cloud:fixture-secret@127.0.0.1:55432/cloud_test\n" +
        "export POSTGRES_HOST=127.0.0.1:55432\n" +
        "export POSTGRES_USER=stll_cloud\n" +
        "export POSTGRES_PASSWORD=fixture-secret\n" +
        "export POSTGRES_DB_NAME=cloud_test\n" +
        "export POSTGRES_ADDITIONAL_CONNECTION_DATA=''\n" +
        "export REDIS_URL=redis://local-test@127.0.0.1:56379/0\n",
    );
    expect(result.stdout.toString()).not.toContain("eval");
  });
}, 15_000);

test("session startup sends every phase's stdout to stderr and reserves stdout for exports", () => {
  const generated = generate({
    ...postgresAndValkeyDeclaration,
    envFile: ".env.custom",
  });
  const { functions } = environmentParts(generated);
  const start = generated.indexOf("\nstart_environment() {");
  const end = generated.indexOf(
    '\n}\nif [[ "$MODE" == session ]]; then',
    start,
  );
  if (start < 0 || end < start)
    throw new Error("Session startup function is missing");
  const startFunction = generated.slice(start + 1, end + 2);
  const program = `${functions}
${startFunction}
step() { printf 'phase-noise\\n'; }
validate_environment() { printf 'validation-noise\\n'; }
write_environment() { printf 'write-noise\\n'; }
DATABASE_URL='postgresql://stll_cloud:fixture-secret@127.0.0.1:55432/cloud_test'
POSTGRES_HOST='127.0.0.1:55432'
POSTGRES_USER='stll_cloud'
POSTGRES_PASSWORD='fixture-secret'
POSTGRES_DB_NAME='cloud_test'
POSTGRES_ADDITIONAL_CONNECTION_DATA=''
REDIS_URL='redis://local-test@127.0.0.1:56379/0'
start_environment >&2
emit_session_environment
`;
  const result = Bun.spawnSync(["bash", "-eu", "-c", program]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(
    "export DATABASE_URL=postgresql://stll_cloud:fixture-secret@127.0.0.1:55432/cloud_test",
  );
  expect(result.stdout.toString()).not.toContain("phase-noise");
  expect(result.stdout.toString()).not.toContain("validation-noise");
  expect(result.stdout.toString()).not.toContain("write-noise");
  expect(result.stderr.toString()).toContain("phase-noise");
  expect(result.stderr.toString()).toContain("validation-noise");
  expect(result.stderr.toString()).toContain("write-noise");
}, 15_000);

test("session shell exports round-trip shell metacharacters without executing substitutions", () => {
  withRepository((root) => {
    const generated = generate(declaration);
    const { functions } = environmentParts(generated);
    const marker = join(root, "expanded-command");
    const password = `quote' $(touch ${marker})\nsecond line`;
    const shellLiteral = (value: string) =>
      `'${value.replaceAll("'", "'\\''")}'`;
    const program = `${functions}
DATABASE_URL='postgresql://fixture'
POSTGRES_HOST='127.0.0.1:55432'
POSTGRES_USER='stll_cloud'
POSTGRES_PASSWORD=${shellLiteral(password)}
POSTGRES_DB_NAME='cloud_test'
POSTGRES_ADDITIONAL_CONNECTION_DATA=''
REDIS_URL=''
emit_session_environment
`;
    const generatedExports = Bun.spawnSync(["bash", "-eu", "-c", program]);
    expect(generatedExports.exitCode).toBe(0);
    const exportFile = join(root, "session-exports.sh");
    writeFileSync(exportFile, generatedExports.stdout);
    const sourced = Bun.spawnSync(
      [
        "bash",
        "-eu",
        "-c",
        'source "$1"; printf "%s" "$POSTGRES_PASSWORD"',
        "session-export-test",
        exportFile,
      ],
      { cwd: root },
    );
    expect(sourced.exitCode).toBe(0);
    expect(sourced.stdout.toString()).toBe(password);
    expect(existsSync(marker)).toBe(false);
  });
}, 15_000);

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
}, 15_000);

test("dependency installation uses the invoking user, home, private cache and pinned frozen Bun", () => {
  withRepository((root) => {
    const generated = generate(declaration);
    const start = generated.indexOf("\ndependency_install() {");
    const closing = generated.indexOf("\n}\n\n", start);
    if (start < 0 || closing < start)
      throw new Error("Missing emitted dependency installer boundary");
    mkdirSync(join(root, "home"));
    writeFileSync(
      join(root, "bun.lock"),
      JSON.stringify({
        packages: {
          fixture: [
            "fixture@1.0.0",
            "https://user:secret@packages.example.test/fixture.tgz",
          ],
        },
      }),
    );
    writeFileSync(
      join(root, ".npmrc"),
      "registry=https://registry.example.test\n",
    );
    const cacheParent = join(root, "cache");
    const helper = generated
      .slice(start, closing + 3)
      .replaceAll("/var/cache/stll-cloud", cacheParent)
      .replaceAll('"$NODE_DIR/bin/node"', '"$TEST_NODE"');
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
EXPECTED_PATH="$PATH"
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
  [[ "$#" == 11 && "$1" == -u && "$2" == "$OUTPUT_USER" && "$3" == -- && "$4" == env ]] || fail 'Dependencies do not run as the caller'
  [[ "$5" == "HOME=$OUTPUT_HOME" && "$6" == "BUN_INSTALL_CACHE_DIR=$BUN_CACHE" && "$7" == "PATH=$EXPECTED_PATH" ]] || fail 'Caller environment is missing'
  [[ "$8" == BUN_CONFIG_HTTP_IDLE_TIMEOUT=20 ]] || fail 'Verified Bun socket timeout is missing'
  [[ "$9" == '/opt/stll-cloud/bun/${policy.bun}/bun' ]] || fail 'Pinned install is missing'
  shift 9
  [[ "$1" == install && "$2" == --frozen-lockfile ]] || fail 'Frozen install is missing'
  printf '%s:%s\n' "$OUTPUT_UID" "$OUTPUT_USER"
}
network_run() {
  [[ "$1" == environment.example.test,packages.example.test,registry.example.test,registry.npmjs.org && "$2" == 240 && "$3" == runuser ]] || fail 'Install deadline or safe download hosts differ'
  shift 2
  "$@"
}
${helper}
dependency_install
dependency_install`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          FIXTURE_ROOT: root,
          TEST_NODE: process.execPath,
          BUN_CONFIG_REGISTRY: "",
          NPM_CONFIG_REGISTRY: "https://user:secret@environment.example.test",
          npm_config_registry: "",
          XDG_CONFIG_HOME: join(root, "home"),
        },
      },
    );
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      "4242:fixture-caller\n4242:fixture-caller\n",
    );
    expect(existsSync(join(cacheParent, "bun/4242"))).toBe(true);
  });
}, 15_000);

const dependencyStateFunctions = (generated: string) => {
  const start = generated.indexOf("\ndependency_hash() {");
  const serviceInstall = generated.indexOf("\nservice_account_ready()", start);
  const boundary =
    serviceInstall < 0
      ? generated.indexOf("\ninstall_services()", start)
      : serviceInstall;
  if (start < 0 || boundary <= start)
    throw new Error("Missing emitted dependency state functions");
  return generated.slice(start, boundary);
};

const runDependencyState = (command: string) =>
  withRepository((root) => {
    writeFileSync(join(root, "bun.lock"), "original\n");
    const state = join(root, "state");
    mkdirSync(state);
    const { uid } = statSync(state);
    const functions = dependencyStateFunctions(generate(declaration))
      .replaceAll("== 0:755", `== ${uid}:755`)
      .replaceAll("== 0:644", `== ${uid}:644`);
    const result = Bun.spawnSync(
      [
        "bash",
        "-eu",
        "-c",
        `fail() { echo "cloud-setup: $*" >&2; exit 1; }
REPO_ROOT="$FIXTURE_ROOT"
DEPENDENCY_STATE_ROOT="$FIXTURE_ROOT/state"
DEPENDENCY_STAMP="$DEPENDENCY_STATE_ROOT/dependencies.sha256"
dependency_install() { printf 'install\\n' >> "$FIXTURE_ROOT/installs"; [[ "\${INSTALL_FAIL:-}" != 1 ]]; }
${functions}
${command}`,
      ],
      { cwd: root, env: { ...process.env, FIXTURE_ROOT: root } },
    );
    return { root, state, result };
  });

test("an equal dependency stamp skips installation", () => {
  const { result } = runDependencyState(`install_dependencies
: > "$FIXTURE_ROOT/installs"
sync_dependencies
[[ ! -s "$FIXTURE_ROOT/installs" ]]`);
  expect(result.exitCode).toBe(0);
});

test("a changed bun.lock reinstalls once and records the new stamp", () => {
  expect(generate(declaration)).toMatch(
    /start_environment\(\) \{[\s\S]*step dependencies sync_dependencies[\s\S]*\n\}/,
  );
  const { result } = runDependencyState(`install_dependencies
: > "$FIXTURE_ROOT/installs"
printf 'changed\\n' > bun.lock
sync_dependencies
sync_dependencies
[[ "$(wc -l < "$FIXTURE_ROOT/installs")" == 1 ]]
[[ "$(cat "$DEPENDENCY_STAMP")" == "$(sha256sum bun.lock | cut -d ' ' -f1)" ]]`);
  expect(result.exitCode).toBe(0);
});

test("a failed changed-lockfile reinstall clears the stamp so start retries", () => {
  const { result } = runDependencyState(`install_dependencies
printf 'changed\\n' > bun.lock
if (INSTALL_FAIL=1 sync_dependencies); then fail 'Expected installation failure'; fi
[[ ! -e "$DEPENDENCY_STAMP" ]]
sync_dependencies
[[ "$(wc -l < "$FIXTURE_ROOT/installs")" == 3 ]]
[[ "$(cat "$DEPENDENCY_STAMP")" == "$(sha256sum bun.lock | cut -d ' ' -f1)" ]]`);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toContain(
    "cloud-setup: bun.lock mismatch; dependency installation failed",
  );
});

const bunRuntimeFunctions = (generated: string) => {
  const start = generated.indexOf("\nbun_route() {");
  const end = generated.indexOf("\ninstall_runtimes() (", start);
  if (start < 0 || end <= start)
    throw new Error("Missing emitted Bun runtime function boundary");
  return generated.slice(start, end);
};

const readProcessState = (pid: number) => {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ").at(2);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
};

test("runtime installation replaces image Bun executables and verifies every resolution route", () => {
  withRepository((root) => {
    const generated = generate(declaration);
    const functions = bunRuntimeFunctions(generated);
    const mise = join(root, "mise");
    const oldInstall = join(mise, "installs/bun/1.2.14/bin");
    const shims = join(mise, "shims");
    const other = join(root, "other-bin");
    const pinned = join(root, "pinned");
    const minimal = join(root, "minimal-bin");
    for (const directory of [oldInstall, shims, other, pinned, minimal])
      mkdirSync(directory, { recursive: true });
    writeFileSync(join(pinned, "bun"), `#!/bin/sh\necho '${policy.bun}'\n`, {
      mode: 0o755,
    });
    for (const executable of [
      "bash",
      "env",
      "find",
      "ln",
      "printenv",
      "readlink",
      "sh",
      "tr",
    ]) {
      const target = Bun.which(executable);
      if (target === null) throw new Error(`Missing ${executable}`);
      symlinkSync(target, join(minimal, executable));
    }
    symlinkSync(join(pinned, "bun"), join(minimal, "bun"));
    writeFileSync(
      join(root, "login-shell"),
      '#!/bin/sh\nshift\nexec sh "$@"\n',
      { mode: 0o755 },
    );
    for (const executable of [
      join(oldInstall, "bun"),
      join(oldInstall, "bunx"),
      join(shims, "bun"),
      join(shims, "bunx"),
      join(other, "bun"),
    ]) {
      writeFileSync(executable, "#!/bin/sh\necho 1.2.14\n");
      chmodSync(executable, 0o755);
    }
    const result = Bun.spawnSync(
      [
        "bash",
        "-eu",
        "-c",
        `fail() { echo "cloud-setup: $*" >&2; exit 1; }
BUN_VERSION='${policy.bun}'
BUN_DIR="$FIXTURE_ROOT/pinned"
OUTPUT_HOME="$FIXTURE_ROOT/home"
export MISE_DATA_DIR="$FIXTURE_ROOT/mise"
export MISE_OFFLINE=1
export STLL_CLOUD_TEST_MINIMAL_PATH="$FIXTURE_ROOT/minimal-bin"
export STLL_CLOUD_TEST_LOGIN_SHELL="$FIXTURE_ROOT/login-shell"
export STLL_CLOUD_TEST_ROOT_MISE="$FIXTURE_ROOT/root-mise"
PATH="$FIXTURE_ROOT/other-bin:$BUN_DIR:$STLL_CLOUD_TEST_MINIMAL_PATH"
${functions}
replace_image_buns
verify_bun_routes
for executable in "$MISE_DATA_DIR/installs/bun/1.2.14/bin/bun" "$MISE_DATA_DIR/installs/bun/1.2.14/bin/bunx" "$MISE_DATA_DIR/shims/bun" "$MISE_DATA_DIR/shims/bunx" "$FIXTURE_ROOT/other-bin/bun"; do
  [[ "$(readlink -f -- "$executable")" == "$BUN_DIR/bun" ]] || fail "Bun was not replaced at $executable"
done`,
      ],
      { env: { ...process.env, FIXTURE_ROOT: root } },
    );
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(generated).toContain("replace_image_buns\n  verify_bun_routes");
    expect(generated).toContain(
      'minimal_path="$(printenv STLL_CLOUD_TEST_MINIMAL_PATH || true)"',
    );
    expect(generated).toContain("bash -l");
  });
}, 30_000);

test("runtime verification names an older Bun that remains on PATH", () => {
  withRepository((root) => {
    const older = join(root, "older");
    mkdirSync(older);
    writeFileSync(join(older, "bun"), "#!/bin/sh\necho 1.2.14\n");
    chmodSync(join(older, "bun"), 0o755);
    const result = Bun.spawnSync(
      [
        "bash",
        "-eu",
        "-c",
        `fail() { echo "cloud-setup: $*" >&2; exit 1; }
BUN_VERSION='${policy.bun}'
OUTPUT_HOME="$FIXTURE_ROOT/home"
PATH="$FIXTURE_ROOT/older:$PATH"
${bunRuntimeFunctions(generate(declaration))}
verify_bun_routes`,
      ],
      { env: { ...process.env, FIXTURE_ROOT: root } },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      `Bun at ${join(older, "bun")} resolves version 1.2.14 through the setup PATH; expected ${policy.bun}`,
    );
  });
}, 15_000);

test("runtime-only declarations emit no environment file code", () => {
  for (const input of [
    { install: cloudInstallCommand },
    { install: cloudInstallCommand, services: [] },
  ]) {
    const generated = generate(input);
    expect(generated).not.toMatch(
      /ENV_FILE|ENV_MARKER|validate_environment|write_environment|DATABASE_URL|REDIS_URL/,
    );
    expect(generated).not.toContain(cloudEnvironmentMarker);
    expect(
      Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(generated) }).exitCode,
    ).toBe(0);
  }
  for (const service of cloudServices) {
    const generated = generate({ ...declaration, services: [service] });
    expect(generated).toContain("validate_environment");
    expect(generated).toContain("write_environment");
    expect(generated).toContain(cloudEnvironmentMarker);
  }
}, 15_000);

test("the declared install command is rendered verbatim into the pinned install", () => {
  const frozen = generate(declaration);
  expect(frozen).toContain('"$BUN_DIR/bun" install --frozen-lockfile\n');
  expect(frozen).not.toContain("--ignore-scripts");
  const scriptless = generate({
    ...declaration,
    install: `${cloudInstallCommand} --ignore-scripts`,
  });
  expect(scriptless).toContain(
    '"$BUN_DIR/bun" install --frozen-lockfile --ignore-scripts\n',
  );
  expect(scriptless).not.toContain("@INSTALL_ARGS@");
}, 15_000);

test("every lifecycle phase runs through the timed step logger", () => {
  const generated = generate(declaration);
  const body = generated.slice(
    generated.indexOf('if [[ "$MODE" == install ]]'),
  );
  const start = generated.indexOf("start_environment() {");
  const end = generated.indexOf(
    '\n}\nif [[ "$MODE" == session ]]; then',
    start,
  );
  if (start < 0 || end < start)
    throw new Error("Session startup function is missing");
  const startFunction = generated.slice(start, end + 2);
  for (const phase of [
    "install_runtimes",
    "install_services",
    "install_tools",
    "install_dependencies",
    "runtime_ready",
    "sync_dependencies",
    "verify_tools",
    "verify_shell_environment",
    "prepare_state",
    "start_services",
  ])
    expect(body).toMatch(new RegExp(`^ *step [a-z-]+ ${phase}$`, "m"));
  for (const phase of [
    "runtime_ready",
    "verify_tools",
    "install_shell_environment",
    "verify_shell_environment",
    "prepare_state",
    "start_services",
  ])
    expect(startFunction).toMatch(new RegExp(`^ *step [a-z-]+ ${phase}$`, "m"));
  expect(generated).toContain(
    'if [[ "$MODE" == session ]]; then\n  start_environment >&2\nelse\n  start_environment\nfi',
  );
  const helper = generated.slice(
    generated.indexOf("step() {"),
    generated.indexOf("}", generated.indexOf("step() {")) + 1,
  );
  const ok = Bun.spawnSync(
    ["bash", "-c", `set -euo pipefail\n${helper}\nstep demo true`],
    { stderr: "pipe" },
  );
  expect(ok.exitCode).toBe(0);
  expect(ok.stderr.toString()).toMatch(
    /^cloud-setup: demo started\ncloud-setup: demo done in \d+s\n$/,
  );
  const failed = Bun.spawnSync(
    ["bash", "-c", `set -euo pipefail\n${helper}\nstep demo false\necho after`],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(failed.exitCode).not.toBe(0);
  expect(failed.stdout.toString()).toBe("");
  expect(failed.stderr.toString()).not.toContain("demo done");
}, 15_000);

test.skipIf(!existsSync("/proc/self/fd"))(
  "service commands inherit no descriptor beyond stdio from the caller",
  () => {
    const generated = generate(declaration);
    const start = generated.indexOf("\nservice_run() (");
    const end = generated.indexOf("\n)\n", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const serviceRun = generated.slice(start, end + 3);
    const bin = mkdtempSync(join(tmpdir(), "cloud-service-run-"));
    try {
      // Stands in for runuser: checks the fixed service identity, then runs the command.
      writeFileSync(
        join(bin, "runuser"),
        '#!/bin/sh\n[ "$1 $2 $3" = "-u stll-cloud --" ] || exit 97\nshift 3\nexec "$@"\n',
        { mode: 0o755 },
      );
      const result = Bun.spawnSync(
        [
          "bash",
          "-eu",
          "-c",
          // Descriptors 30 and 31 model a runner terminal passed beyond stdio; 9 is the state lock.
          `${serviceRun}\nexec 9</dev/null 30</dev/null 31</dev/null\nservice_run sh -c 'ls /proc/$$/fd; :'\nls /proc/$$/fd`,
        ],
        { env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}` } },
      );
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      const [service, caller] = result.stdout
        .toString()
        .trim()
        .split(/\n(?=0\n)/)
        .map((block) => block.split("\n"));
      expect(service).toEqual(["0", "1", "2"]);
      // The caller keeps its own descriptors; only the service process sheds them.
      expect(caller).toEqual(expect.arrayContaining(["30", "31", "9"]));
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  },
);

const prepared = {
  install: `${cloudInstallCommand} --ignore-scripts`,
  prepare: { script: "generate:cloud", seconds: 300 },
};
const manifest = JSON.stringify({
  scripts: { "generate:cloud": "turbo run generate:route-tree" },
});
const generatePrepared = (files: Record<string, string>) => {
  const cloud = parseCloudSetup(prepared);
  if (cloud === undefined) throw new Error("Missing cloud declaration");
  return generateCloudSetup({ policy, cloud, nodeVersion: "26.10.0", files });
};

test("a prepare script runs once after dependencies, offline and time-bounded", () => {
  const generated = generatePrepared({ "package.json": manifest });
  expect(generated).toContain(
    `timeout --kill-after=10 300 runuser -u "$OUTPUT_USER" -- env HOME="$OUTPUT_HOME" PATH="$PATH" "$BUN_DIR/bun" run 'generate:cloud' </dev/null &`,
  );
  expect(generated).toContain('kill -KILL -- "-$leader" 2>/dev/null || true');
  const install = generated.slice(
    generated.indexOf('if [[ "$MODE" == install ]]; then'),
  );
  const dependencies = install.indexOf(
    "step dependencies install_dependencies",
  );
  const prepare = install.indexOf("step prepare prepare_sources");
  expect(dependencies).toBeGreaterThan(-1);
  expect(prepare).toBeGreaterThan(dependencies);
  expect(prepare).toBeLessThan(install.indexOf("exit 0"));
  expect(generated.match(/step prepare prepare_sources/g)).toHaveLength(1);
  const syntax = Bun.spawnSync(["bash", "-n"], {
    stdin: Buffer.from(generated),
  });
  expect(syntax.stderr.toString()).toBe("");
  expect(syntax.exitCode).toBe(0);
  expect(generate(declaration)).not.toContain("prepare_sources");
}, 15_000);

test("a prepare script must be a root package script", () => {
  expect(() => generatePrepared({})).toThrow(
    "cloud.prepare requires a tracked root package.json",
  );
  for (const scripts of [
    undefined,
    {},
    { other: "true" },
    { "generate:cloud": null },
    { "generate:cloud": ["turbo"] },
  ]) {
    expect(() =>
      generatePrepared({ "package.json": JSON.stringify({ scripts }) }),
    ).toThrow(
      "cloud.prepare.script generate:cloud is not a root package script",
    );
  }
}, 15_000);

test("an inherited name is not a root package script", () => {
  const cloud = parseCloudSetup({
    install: cloudInstallCommand,
    prepare: { script: "constructor", seconds: 5 },
  });
  if (cloud === undefined) throw new Error("Missing cloud declaration");
  expect(() =>
    generateCloudSetup({
      policy,
      cloud,
      nodeVersion: "26.10.0",
      files: { "package.json": JSON.stringify({ scripts: {} }) },
    }),
  ).toThrow("cloud.prepare.script constructor is not a root package script");
}, 15_000);

// The bound must hold for descendants that ignore TERM: timeout only escalates
// while its direct child runs, so the step kills what is left of its group.
test.skipIf(Bun.which("timeout") === null)(
  "prepare kills a TERM-ignoring descendant once the bound passes",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "cloud-prepare-"));
    try {
      const pidFile = join(directory, "descendant.pid");
      const bin = join(directory, "bin");
      mkdirSync(bin);
      // Stand-ins for runuser and bun: the script leaves a TERM-ignoring
      // descendant behind and exits as soon as it is signalled.
      writeFileSync(
        join(bin, "runuser"),
        '#!/usr/bin/env bash\nwhile [[ "$1" != -- ]]; do shift; done\nshift\nexec "$@"\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "bun"),
        `#!/usr/bin/env bash\nbash -c 'trap "" TERM; echo $$ > ${pidFile}; exec sleep 60' &\nsleep 60\n`,
        { mode: 0o755 },
      );
      const generated = generatePrepared({ "package.json": manifest }).replace(
        "--kill-after=10 300",
        "--kill-after=1 1",
      );
      const definition = generated.slice(
        generated.indexOf("prepare_sources() {"),
        generated.indexOf("\n}\n", generated.indexOf("prepare_sources() {")) +
          3,
      );
      const run = Bun.spawnSync(
        [
          "bash",
          "-c",
          `${definition}\nOUTPUT_USER=x OUTPUT_HOME=${directory} BUN_DIR=${bin} PATH=${bin}:$PATH prepare_sources; echo "status=$?"`,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 20_000 },
      );
      expect(run.stdout.toString()).toMatch(/status=(124|137)/);
      const pid = Number(readFileSync(pidFile, "utf-8").trim());
      expect(Number.isSafeInteger(pid)).toBe(true);
      // Reaping can lag the kill by a moment; poll briefly.
      let alive = true;
      for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
        const state = readProcessState(pid);
        alive =
          Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0 &&
          state !== "Z";
        if (alive) Bun.sleepSync(100);
      }
      expect(alive).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
