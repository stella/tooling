import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { cloudEnvironmentMarker } from "../packages/oxlint-config/src/cloud-setup";
import { parseToolchainPolicy } from "../packages/oxlint-config/src/toolchain-schema";

type CommandOptions = {
  label: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  outcome?: "success" | "failure";
  output?: "trimmed" | "raw";
};

// Capture engine output: connection credentials must never enter CI logs.
const command = async ({
  label,
  args,
  cwd,
  env,
  outcome = "success",
  output = "trimmed",
}: CommandOptions) => {
  const child = Bun.spawn(args, {
    cwd,
    env: env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if ((exitCode === 0) !== (outcome === "success"))
    throw new Error(`${label}: unexpected command status ${exitCode}`);
  return output === "raw" ? stdout : stdout.trim();
};

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const main = async () => {
  assert(
    process.env["CI"] === "true" && process.platform === "linux",
    "This integration runs only in Linux CI",
  );
  const release = await readFile("/etc/os-release", "utf8");
  assert(
    /^ID=ubuntu$/m.test(release) && /^VERSION_ID="24\.04"$/m.test(release),
    "Ubuntu 24.04 is required",
  );
  const rootPrefix = process.getuid?.() === 0 ? [] : ["sudo", "-n", "--"];
  await command({
    label: "Service administration",
    args: [...rootPrefix, "true"],
  });
  const source = resolve(import.meta.dirname, "..");
  const policy = parseToolchainPolicy(
    JSON.parse(
      await readFile(
        join(source, "packages/oxlint-config/toolchain.json"),
        "utf8",
      ),
    ),
  );
  const nodeVersion = (
    await readFile(join(source, ".node-version"), "utf8")
  ).trim();
  const fixture = await realpath(
    await mkdtemp(join(tmpdir(), "cloud-setup-integration-")),
  );
  const state = `/var/lib/stll-cloud/${createHash("sha256").update(fixture).digest("hex")}`;
  const pgBin = `/usr/lib/postgresql/${policy.postgres}/bin`;
  let databaseUrl: URL | undefined;
  let redisUrl: URL | undefined;
  const root = (args: string[], label: string) =>
    command({ label, args: [...rootPrefix, ...args] });
  const generated = join(fixture, ".agents/cloud-setup.sh");
  const envPath = join(fixture, "apps/api/.env.test");
  const readEnvironment = () =>
    command({
      label: "Generated local environment",
      args: [...rootPrefix, "cat", envPath],
      output: "raw",
    });
  const start = (outcome: "success" | "failure" = "success") =>
    command({
      label: "Generated offline service start",
      args: ["bash", generated, "start"],
      outcome,
    });
  const pgQuery = (query: string) => {
    if (databaseUrl === undefined)
      throw new Error("Database connection is unavailable");
    return command({
      label: "Authenticated PostgreSQL query",
      args: [
        ...rootPrefix,
        "env",
        `PGPASSWORD=${databaseUrl.password}`,
        "PGHOSTADDR=127.0.0.1",
        "PGCONNECT_TIMEOUT=2",
        `${pgBin}/psql`,
        "-X",
        "-h",
        "127.0.0.1",
        "-p",
        "55432",
        "-U",
        "stll_cloud",
        "-d",
        "cloud_test",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        query,
      ],
    });
  };
  const valkey = (args: string[]) => {
    if (redisUrl === undefined)
      throw new Error("Valkey connection is unavailable");
    return command({
      label: "Authenticated Valkey command",
      args: [
        ...rootPrefix,
        "env",
        `VALKEYCLI_AUTH=${redisUrl.password}`,
        "timeout",
        "3",
        "valkey-cli",
        "-h",
        "127.0.0.1",
        "-p",
        "56379",
        "--raw",
        ...args,
      ],
    });
  };
  const nonrootInstall = async () => {
    const username = `stll-cloud-ci-${process.pid}`;
    const home = `/home/${username}`;
    const consumer = join(fixture, "nonroot-consumer");
    const userScript = join(consumer, ".agents/cloud-setup.sh");
    const sudoers = `/etc/sudoers.d/${username}`;
    let userState: "absent" | "created" = "absent";
    try {
      await root(["test", "!", "-e", home], "Isolated consumer home");
      await root(["test", "!", "-e", sudoers], "Isolated sudo rule");
      await root(
        [
          "useradd",
          "--create-home",
          "--user-group",
          "--shell",
          "/bin/bash",
          username,
        ],
        "Create nonroot consumer",
      );
      userState = "created";
      await root(["chmod", "711", fixture], "Consumer fixture traversal");
      await mkdir(join(consumer, "local-package"), { recursive: true });
      await mkdir(join(consumer, "apps/api"), { recursive: true });
      await writeFile(
        join(consumer, "local-package/package.json"),
        JSON.stringify({
          name: "cloud-local-dependency",
          version: "1.0.0",
          main: "index.js",
        }),
      );
      await writeFile(
        join(consumer, "local-package/index.js"),
        "module.exports = 1;\n",
      );
      await writeFile(
        join(consumer, "package.json"),
        JSON.stringify({
          name: "cloud-nonroot-integration",
          private: true,
          packageManager: `bun@${policy.bun}`,
          dependencies: { "cloud-local-dependency": "file:./local-package" },
        }),
      );
      await writeFile(join(consumer, ".node-version"), `${nodeVersion}\n`);
      await writeFile(
        join(consumer, "stll-toolchain.json"),
        JSON.stringify({
          optOuts: [],
          cloud: {
            services: [],
            install: "bun install --frozen-lockfile",
            envFile: "apps/api/.env.test",
          },
        }),
      );
      await command({
        label: "Local dependency lockfile",
        args: [process.execPath, "install", "--lockfile-only"],
        cwd: consumer,
      });
      await command({
        label: "Nonroot fixture initialization",
        args: ["git", "init", "--quiet"],
        cwd: consumer,
      });
      await command({
        label: "Nonroot tracked declaration",
        args: [
          "git",
          "add",
          "package.json",
          "bun.lock",
          ".node-version",
          "stll-toolchain.json",
        ],
        cwd: consumer,
      });
      await command({
        label: "Nonroot setup generation",
        args: [
          process.execPath,
          join(source, "packages/oxlint-config/src/cloud-setup-cli.ts"),
        ],
        cwd: consumer,
      });
      const rule = join(fixture, "nonroot-sudo-rule");
      // Authorize only this generated install command, never unrestricted sudo.
      await writeFile(
        rule,
        `${username} ALL=(root) NOPASSWD: /usr/bin/true, /usr/bin/bash ${userScript} install\n`,
      );
      await root(
        ["install", "-m", "440", "-o", "root", "-g", "root", rule, sudoers],
        "Scoped installer authorization",
      );
      await root(["visudo", "-cf", sudoers], "Validate scoped sudo rule");
      await root(
        ["chown", "-R", `${username}:${username}`, consumer],
        "Nonroot repository ownership",
      );
      await root(
        [
          "runuser",
          "-u",
          username,
          "--",
          "env",
          `HOME=${home}`,
          "bash",
          userScript,
          "install",
        ],
        "Nonroot generated install through sudo",
      );
      const verifyWrite = `
const fs = require("node:fs");
const path = require("node:path");
const uid = process.getuid();
for (const file of ["node_modules", "node_modules/cloud-local-dependency/package.json"])
  if (fs.statSync(path.join(process.env.CONSUMER, file)).uid !== uid) process.exit(1);
const vite = path.join(process.env.CONSUMER, "node_modules/.vite");
fs.mkdirSync(vite, { recursive: true });
fs.writeFileSync(path.join(vite, "consumer-cache"), "ready");
if (fs.statSync(path.join(vite, "consumer-cache")).uid !== uid) process.exit(1);
`;
      await root(
        [
          "runuser",
          "-u",
          username,
          "--",
          "env",
          `HOME=${home}`,
          `CONSUMER=${consumer}`,
          `/opt/stll-cloud/node/${nodeVersion}/bin/node`,
          "-e",
          verifyWrite,
        ],
        "Nonroot dependency ownership and Vite write",
      );
    } finally {
      if (userState === "created") {
        await root(
          ["rm", "-f", "--", sudoers],
          "Remove scoped installer authorization",
        );
        await root(
          ["rm", "-rf", "--", consumer],
          "Remove isolated consumer fixture",
        );
        await root(
          ["userdel", "--remove", username],
          "Remove isolated consumer user",
        );
      }
    }
  };
  try {
    await mkdir(dirname(envPath), { recursive: true });
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify({
        name: "cloud-integration",
        private: true,
        packageManager: `bun@${policy.bun}`,
      }),
    );
    await writeFile(join(fixture, ".node-version"), `${nodeVersion}\n`);
    await writeFile(
      join(fixture, "stll-toolchain.json"),
      JSON.stringify({
        optOuts: [],
        cloud: {
          services: ["postgres", "valkey"],
          install: "bun install --frozen-lockfile",
          envFile: "apps/api/.env.test",
        },
      }),
    );
    await command({
      label: "Fixture lockfile generation",
      args: [process.execPath, "install", "--lockfile-only"],
      cwd: fixture,
    });
    try {
      await readFile(join(fixture, "bun.lock"));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      // Bun may omit an empty lock; preserve an explicit frozen fixture contract.
      await writeFile(
        join(fixture, "bun.lock"),
        JSON.stringify({
          lockfileVersion: 1,
          workspaces: { "": { name: "cloud-integration" } },
          packages: {},
        }),
      );
    }
    await command({
      label: "Fixture repository initialization",
      args: ["git", "init", "--quiet"],
      cwd: fixture,
    });
    await command({
      label: "Fixture tracked declaration",
      args: [
        "git",
        "add",
        "package.json",
        "bun.lock",
        ".node-version",
        "stll-toolchain.json",
      ],
      cwd: fixture,
    });
    await command({
      label: "Cloud setup generation",
      args: [
        process.execPath,
        join(source, "packages/oxlint-config/src/cloud-setup-cli.ts"),
      ],
      cwd: fixture,
    });
    await command({
      label: "Generated runtime and dependency install",
      args: ["bash", generated, "install"],
    });
    await command({
      label: "Cached runtime and dependency install",
      args: ["bash", generated, "install"],
    });
    assert(
      (await command({
        label: "Installed Bun version",
        args: [`/opt/stll-cloud/bun/${policy.bun}/bun`, "--version"],
      })) === policy.bun,
      "Installed Bun pin differs",
    );
    assert(
      (await command({
        label: "Installed Node version",
        args: [`/opt/stll-cloud/node/${nodeVersion}/bin/node`, "--version"],
      })) === `v${nodeVersion}`,
      "Installed Node pin differs",
    );
    await nonrootInstall();
    await start();
    const environment = await readEnvironment();
    const lines = environment.split("\n");
    assert(
      lines.at(0) === cloudEnvironmentMarker &&
        lines.at(1) === "NODE_ENV=test" &&
        lines.length === 5 &&
        lines.at(4) === "",
      "Generated environment shape differs",
    );
    const database = lines.find((line) => line.startsWith("DATABASE_URL="));
    const redis = lines.find((line) => line.startsWith("REDIS_URL="));
    assert(
      database !== undefined && redis !== undefined,
      "Both service connections are required",
    );
    if (database === undefined || redis === undefined)
      throw new Error("Service connections are absent");
    try {
      databaseUrl = new URL(database.slice("DATABASE_URL=".length));
      redisUrl = new URL(redis.slice("REDIS_URL=".length));
    } catch {
      throw new Error("Generated local connection syntax is invalid");
    }
    assert(
      databaseUrl.hostname === "127.0.0.1" &&
        databaseUrl.port === "55432" &&
        databaseUrl.pathname === "/cloud_test",
      "Database connection must be local",
    );
    assert(
      redisUrl.hostname === "127.0.0.1" &&
        redisUrl.port === "56379" &&
        redisUrl.pathname === "/0",
      "Valkey connection must be local",
    );
    assert((await pgQuery("SELECT 1")) === "1", "PostgreSQL query failed");
    assert(
      (await pgQuery("SHOW data_directory")) === `${state}/postgres`,
      "PostgreSQL data ownership differs",
    );
    assert(
      Math.floor(Number(await pgQuery("SHOW server_version_num")) / 10_000) ===
        Number(policy.postgres),
      "PostgreSQL major differs",
    );
    assert((await valkey(["PING"])) === "PONG", "Valkey readiness failed");
    assert(
      (await valkey(["SET", "cloud-integration", "ready"])) === "OK",
      "Valkey write failed",
    );
    assert(
      (await valkey(["GET", "cloud-integration"])) === "ready",
      "Valkey read failed",
    );
    assert(
      (await valkey(["INFO", "server"]))
        .split(/\r?\n/)
        .includes(`valkey_version:${policy.valkey}`),
      "Valkey exact version differs",
    );
    await root(
      [
        `/opt/stll-cloud/bun/${policy.bun}/bun`,
        `--env-file=${envPath}`,
        "-e",
        'if (process.env.NODE_ENV !== "test" || !process.env.DATABASE_URL || !process.env.REDIS_URL) process.exit(1)',
      ],
      "Generated environment loading",
    );
    await start();
    assert(
      (await readEnvironment()) === environment,
      "Repeated startup changed local environment",
    );
    await root(["rm", envPath], "Prepare unowned environment fixture");
    await writeFile(envPath, "UNOWNED_TEST_FILE=1\n");
    await start("failure");
    assert(
      (await readFile(envPath, "utf8")) === "UNOWNED_TEST_FILE=1\n",
      "Unowned environment was modified",
    );
    await rm(envPath);
    const outside = join(fixture, "outside-test-file");
    await writeFile(outside, "unchanged\n");
    await symlink(outside, envPath);
    await start("failure");
    assert(
      (await readFile(outside, "utf8")) === "unchanged\n",
      "Symbolic environment target was modified",
    );
  } finally {
    // Match the exact generated state and executable before stopping any process.
    const cleanup = String.raw`
set -euo pipefail
if [[ -f "$STATE/postgres/postmaster.pid" && ! -L "$STATE/postgres/postmaster.pid" ]]; then
  pid="$(head -n 1 "$STATE/postgres/postmaster.pid")"
  if [[ "$pid" =~ ^[1-9][0-9]*$ && "$(readlink -f "/proc/$pid/exe")" == "$PG_BIN/postgres" && "$(sed -n '2p' "$STATE/postgres/postmaster.pid")" == "$STATE/postgres" && "$(stat -c '%u' "/proc/$pid")" == "$(id -u stll-cloud)" ]]; then
    runuser -u stll-cloud -- "$PG_BIN/pg_ctl" -D "$STATE/postgres" -m fast -t 10 -w stop >/dev/null
  fi
fi
if [[ -f "$STATE/valkey/valkey.pid" && ! -L "$STATE/valkey/valkey.pid" && -f "$STATE/valkey.password" ]]; then
  pid="$(cat "$STATE/valkey/valkey.pid")"
  if [[ "$pid" =~ ^[1-9][0-9]*$ && "$(readlink -f "/proc/$pid/exe")" == "$(readlink -f "$(command -v valkey-server)")" && "$(stat -c '%u' "/proc/$pid")" == "$(id -u stll-cloud)" ]]; then
    export VALKEYCLI_AUTH="$(cat "$STATE/valkey.password")"
    info="$(timeout 2 valkey-cli -h 127.0.0.1 -p 56379 --raw INFO server)"
    if [[ "$info" == *"process_id:$pid"$'\r\n'* && "$info" == *"config_file:$STATE/valkey/valkey.conf"$'\r\n'* ]]; then
      timeout 2 valkey-cli -h 127.0.0.1 -p 56379 SHUTDOWN NOSAVE
    fi
  fi
fi
if [[ -e "$STATE" ]]; then
  [[ -d "$STATE" && ! -L "$STATE" && "$(stat -c '%u' "$STATE")" == 0 ]] || exit 1
  [[ ! -e "$STATE/postgres/postmaster.pid" && ! -e "$STATE/valkey/valkey.pid" ]] || exit 1
  rm -rf -- "$STATE"
fi
`;
    await command({
      label: "Owned integration service cleanup",
      args: [
        ...rootPrefix,
        "env",
        `STATE=${state}`,
        `PG_BIN=${pgBin}`,
        "bash",
        "-c",
        cleanup,
      ],
    });
    await rm(fixture, { recursive: true, force: true });
  }
  process.stdout.write("Cloud setup engine integration passed\n");
};

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Cloud setup integration failed"}\n`,
  );
  process.exitCode = 1;
});
