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
import {
  cloudSetupArtifacts,
  cloudSetupPackages,
} from "../packages/oxlint-config/src/cloud-setup-artifacts";
import { renderCloudNetwork } from "../packages/oxlint-config/src/cloud-setup-network";
import { cloudShellProfileSource } from "../packages/oxlint-config/src/cloud-setup-shell";
import { parseToolchainPolicy } from "../packages/oxlint-config/src/toolchain-schema";

const freshShellPath =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

type CommandOptions = {
  label: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  outcome?: "success" | "failure";
  output?: "trimmed" | "raw";
};

const diagnosticText = (value: string) =>
  value
    .replace(
      /(PGPASSWORD|POSTGRES_PASSWORD|VALKEYCLI_AUTH|DATABASE_URL|REDIS_URL)=[^\s]+/g,
      "$1=[redacted]",
    )
    .replace(
      /(?:postgres(?:ql)?|rediss?):\/\/[^\s"']+/gi,
      "[local connection redacted]",
    )
    .replace(/\b[a-f0-9]{64}\b/gi, "[digest redacted]");

// Capture engine output and redact local connection values in failure details.
const command = async ({
  label,
  args,
  cwd,
  env,
  outcome = "success",
  output = "trimmed",
}: CommandOptions) => {
  const child = Bun.spawn(args, {
    ...(cwd === undefined ? {} : { cwd }),
    env: env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if ((exitCode === 0) !== (outcome === "success")) {
    throw new Error(
      [
        `${label}: unexpected command status ${exitCode}`,
        `Command: ${JSON.stringify(args.map(diagnosticText))}`,
        `stderr:\n${diagnosticText(stderr)}`,
      ].join("\n"),
    );
  }
  return output === "raw" ? stdout : stdout.trim();
};

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const timedCommand = async (options: CommandOptions) => {
  const started = performance.now();
  const output = await command(options);
  process.stdout.write(
    `${options.label}: ${((performance.now() - started) / 1000).toFixed(2)} seconds\n`,
  );
  return output;
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
  await command({
    label: "Offline network namespace capability",
    args: [...rootPrefix, "unshare", "--net", "--", "true"],
  });
  const timeoutStarted = performance.now();
  const timeoutDiagnostic = await command({
    label: "Real GNU timeout deadline",
    args: [
      "bash",
      "-c",
      `exec 2>&1\nfail() { echo "$*" >&2; exit 1; }\n${renderCloudNetwork()}\nnetwork_run static.rust-lang.org 1 sleep 10`,
    ],
    outcome: "failure",
  });
  assert(
    timeoutDiagnostic.includes("download timed out: static.rust-lang.org") &&
      performance.now() - timeoutStarted < 5000,
    "GNU timeout did not enforce the deadline with its download host diagnostic",
  );
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
  const freshShell = () => {
    const verifyRuntime = String.raw`
set -euo pipefail
trap 'echo "Fresh shell check failed at line $LINENO" >&2' ERR
[[ "$(bun --version)" == "$BUN_VERSION" ]]
[[ "$(node --version)" == "v$NODE_VERSION" ]]
[[ "$(rustc --version)" == "rustc $RUST_VERSION "* ]]
[[ "$(cargo --version)" == "cargo $RUST_VERSION "* ]]
[[ "$(rustup --version 2>/dev/null)" == "rustup $RUSTUP_VERSION "* ]]
nextest_version="$(cargo nextest --version)"
[[ "$nextest_version" == "cargo-nextest $NEXTEST_VERSION" || "$nextest_version" == "cargo-nextest $NEXTEST_VERSION "* ]]
[[ "$(gitleaks --version)" == "gitleaks version $GITLEAKS_VERSION" ]]
[[ "$(wasm-bindgen --version)" == "wasm-bindgen $WASM_BINDGEN_VERSION" ]]
uv_version="$(uv --version)"
uvx_version="$(uvx --version)"
[[ "$uv_version" == "uv $UV_VERSION" || "$uv_version" == "uv $UV_VERSION "* ]]
[[ "$uvx_version" == "uvx $UV_VERSION" || "$uvx_version" == "uvx $UV_VERSION "* ]]
[[ "$(/usr/bin/time -v true 2>&1)" == *"Maximum resident set size"* ]]
[[ "$(rustup target list --installed)" == *wasm32-unknown-unknown* ]]
components="$(rustup component list --installed)"
[[ "$components" == *clippy-* && "$components" == *rustfmt-* ]]
for tool in bun node rustc cargo rustup cargo-nextest wasm-bindgen wasm-bindgen-test-runner wasm2es6js gitleaks uv uvx; do
  executable="$(readlink -f "$(command -v "$tool")")"
  printf '%s %s ' "$tool" "$executable"
  stat -c '%i:%s:%y' "$executable"
done
for tool in rustc cargo rustdoc rustfmt clippy-driver; do
  executable="$(rustup which "$tool")"
  printf 'rust-toolchain-%s %s ' "$tool" "$executable"
  stat -c '%i:%s:%y' "$executable"
done
`;
    return command({
      label: "Offline fresh shell versions and installed file identity",
      args: [
        ...rootPrefix,
        "unshare",
        "--net",
        "--",
        "env",
        "-i",
        `PATH=${freshShellPath}`,
        `HOME=${fixture}`,
        `BUN_VERSION=${policy.bun}`,
        `NODE_VERSION=${nodeVersion}`,
        `RUST_VERSION=${policy.rust}`,
        `RUSTUP_VERSION=${cloudSetupArtifacts["rustup-init"].version}`,
        `NEXTEST_VERSION=${cloudSetupArtifacts["cargo-nextest"].version}`,
        `WASM_BINDGEN_VERSION=${cloudSetupArtifacts["wasm-bindgen-cli"].version}`,
        `GITLEAKS_VERSION=${cloudSetupArtifacts.gitleaks.version}`,
        `UV_VERSION=${cloudSetupArtifacts.uv.version}`,
        "bash",
        "--noprofile",
        "--norc",
        "-c",
        verifyRuntime,
      ],
      cwd: fixture,
    });
  };
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
  type SpawnedIdentity =
    | { status: "pending" }
    | {
        status: "verified";
        pid: string;
        uid: string;
        executable: string;
        started: string;
      };
  const stalePidRestart = async () => {
    const savedPgPid = await root(
      ["cat", `${state}/postgres/postmaster.pid`],
      "Managed PostgreSQL identifier state",
    );
    assert(savedPgPid.includes("\n"), "PostgreSQL identifier rows are absent");
    assert(
      (await pgQuery("SHOW data_directory")) === `${state}/postgres`,
      "Restart database ownership differs",
    );
    await root(
      [
        "runuser",
        "-u",
        "stll-cloud",
        "--",
        `${pgBin}/pg_ctl`,
        "-D",
        `${state}/postgres`,
        "-m",
        "fast",
        "-t",
        "10",
        "-w",
        "stop",
      ],
      "Stop authenticated managed PostgreSQL for restart",
    );
    await valkey(["SHUTDOWN", "NOSAVE"]);
    // Report the actual service-user PID before replacing the shell with sleep.
    const monitor = Bun.spawn(
      [
        ...rootPrefix,
        "runuser",
        "-u",
        "stll-cloud",
        "--",
        "sh",
        "-c",
        'printf "%s\\n" "$$"; exec sleep 120',
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    let identity: SpawnedIdentity = { status: "pending" };
    const cleanupChild = async (childIdentity: SpawnedIdentity) => {
      switch (childIdentity.status) {
        case "verified": {
          const removeStale = String.raw`
set -euo pipefail
if [[ -d "/proc/$CHILD_PID" && "$(stat -c '%u' "/proc/$CHILD_PID")" == "$CHILD_UID" && "$(readlink -f "/proc/$CHILD_PID/exe")" == "$CHILD_EXE" && "$(awk '{ print $22 }' "/proc/$CHILD_PID/stat")" == "$CHILD_STARTED" ]]; then
  kill -TERM -- "$CHILD_PID"
fi
for file in "$STATE/postgres/postmaster.pid" "$STATE/valkey/valkey.pid"; do
  if [[ -f "$file" && ! -L "$file" && "$(head -n 1 "$file")" == "$CHILD_PID" ]]; then rm -- "$file"; fi
done
`;
          await root(
            [
              "env",
              `STATE=${state}`,
              `CHILD_PID=${childIdentity.pid}`,
              `CHILD_UID=${childIdentity.uid}`,
              `CHILD_EXE=${childIdentity.executable}`,
              `CHILD_STARTED=${childIdentity.started}`,
              "bash",
              "-c",
              removeStale,
            ],
            "Remove only spawned child and injected identifiers",
          );
          break;
        }
        case "pending":
          break;
        default: {
          const exhaustive: never = childIdentity;
          throw new Error(`Unexpected child state: ${String(exhaustive)}`);
        }
      }
    };
    try {
      const reader = monitor.stdout.getReader();
      const decoder = new TextDecoder();
      let handshake = "";
      const deadline = Date.now() + 5000;
      while (!handshake.includes("\n")) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new Error("Service-user child handshake timed out");
        const received = await Promise.race([
          reader.read(),
          Bun.sleep(remaining).then(() => {
            throw new Error("Service-user child handshake timed out");
          }),
        ]);
        if (received.done)
          throw new Error("Service-user child handshake failed");
        handshake += decoder.decode(received.value, { stream: true });
        assert(
          handshake.length <= 20,
          "Service-user child handshake is invalid",
        );
      }
      reader.releaseLock();
      const pid = handshake.trim();
      assert(
        /^[1-9][0-9]*$/.test(pid),
        "Service-user child identifier is invalid",
      );
      const sleepIdentity = String.raw`
set -euo pipefail
for ((attempt=0; attempt<40; attempt++)); do
  executable="$(readlink -f "/proc/$CHILD_PID/exe")" || exit 1
  if [[ "$executable" == */sleep ]]; then printf '%s\n' "$executable"; exit 0; fi
  sleep 0.05
done
exit 1
`;
      const executable = await root(
        ["env", `CHILD_PID=${pid}`, "bash", "-c", sleepIdentity],
        "Unrelated child executable",
      );
      const uid = await root(
        ["stat", "-c", "%u", `/proc/${pid}`],
        "Unrelated child owner",
      );
      const started = await root(
        ["awk", "{ print $22 }", `/proc/${pid}/stat`],
        "Unrelated child start identity",
      );
      assert(
        uid ===
          (await root(["id", "-u", "stll-cloud"], "Managed service owner")),
        "Cached identifier child must have the same service owner",
      );
      assert(
        executable.endsWith("/sleep"),
        "Cached identifier child must have a different executable",
      );
      identity = { status: "verified", pid, uid, executable, started };
      const stalePg = join(fixture, "stale-postgres-pid");
      const staleValkey = join(fixture, "stale-valkey-pid");
      await writeFile(
        stalePg,
        `${pid}${savedPgPid.slice(savedPgPid.indexOf("\n"))}\n`,
      );
      await writeFile(staleValkey, `${pid}\n`);
      await root(
        [
          "install",
          "-m",
          "600",
          "-o",
          "stll-cloud",
          "-g",
          "stll-cloud",
          stalePg,
          `${state}/postgres/postmaster.pid`,
        ],
        "Cached PostgreSQL identifier fixture",
      );
      await root(
        [
          "install",
          "-m",
          "600",
          "-o",
          "stll-cloud",
          "-g",
          "stll-cloud",
          staleValkey,
          `${state}/valkey/valkey.pid`,
        ],
        "Cached Valkey identifier fixture",
      );
      await start();
      assert(
        (await pgQuery("SELECT 1")) === "1",
        "PostgreSQL stale-identifier restart failed",
      );
      assert(
        (await valkey(["PING"])) === "PONG",
        "Valkey stale-identifier restart failed",
      );
      assert(monitor.exitCode === null, "Restart stopped an unrelated child");
      assert(
        (await root(
          ["readlink", "-f", `/proc/${pid}/exe`],
          "Preserved child executable",
        )) === executable,
        "Unrelated child executable changed",
      );
      assert(
        (await root(
          ["stat", "-c", "%u", `/proc/${pid}`],
          "Preserved child owner",
        )) === uid,
        "Unrelated child owner changed",
      );
      assert(
        (await root(
          ["awk", "{ print $22 }", `/proc/${pid}/stat`],
          "Preserved child start identity",
        )) === started,
        "Unrelated child start identity changed",
      );
    } finally {
      try {
        await cleanupChild(identity);
      } finally {
        // This retained monitor belongs to this fixture; never signal a cached PID.
        if (monitor.exitCode === null) monitor.kill();
        await monitor.exited;
      }
    }
  };
  const nonrootInstall = async () => {
    const username = `stll-cloud-ci-${process.pid}`;
    const home = `/home/${username}`;
    const consumer = join(fixture, "nonroot-consumer");
    const staleRuntimeBin = join(consumer, "stale-runtime-bin");
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
      await mkdir(staleRuntimeBin, { recursive: true });
      for (const tool of ["bun", "node"])
        await writeFile(
          join(staleRuntimeBin, tool),
          '#!/bin/sh\nprintf "%s\\n" "stale-runtime"\n',
          { mode: 0o755 },
        );
      const startupFiles = [
        ".bashrc",
        ".profile",
        ".bash_profile",
        ".bash_login",
      ];
      const startupSeed = (file: string) =>
        `# Existing consumer startup settings\nexport CLOUD_STARTUP_PRESERVED=ready\n${file === ".bashrc" ? "case $- in *i*) ;; *) return ;; esac\n" : ""}export PATH='${staleRuntimeBin}':"$PATH"\n`;
      const startupTemplate = join(fixture, "consumer-startup-template");
      for (const file of startupFiles) {
        await writeFile(startupTemplate, startupSeed(file));
        await root(
          [
            "install",
            "-m",
            "644",
            "-o",
            username,
            "-g",
            username,
            startupTemplate,
            join(home, file),
          ],
          "Seed existing user startup settings and stale runtime PATH",
        );
      }
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
      // Authorize only this generated lifecycle, never unrestricted sudo.
      await writeFile(
        rule,
        `${username} ALL=(root) NOPASSWD: /usr/bin/true, /usr/bin/bash ${userScript} install, /usr/bin/bash ${userScript} start\n`,
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
      const startupAfterInstall = [];
      for (const file of startupFiles) {
        const text = await root(
          ["cat", join(home, file)],
          "Installed user startup settings",
        );
        assert(
          text.includes(startupSeed(file)) &&
            text.split("\n").filter((line) => line === cloudShellProfileSource)
              .length === (file === ".bashrc" ? 2 : 1),
          "User startup settings were replaced or cloud profile source is duplicated",
        );
        startupAfterInstall.push(text);
      }
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
        "Cached nonroot generated install through sudo",
      );
      for (const [index, file] of startupFiles.entries())
        assert(
          (await root(
            ["cat", join(home, file)],
            "Cached user startup settings",
          )) === startupAfterInstall.at(index),
          "Cached installation changed user startup settings",
        );
      const verifyShellPath = String.raw`
set -euo pipefail
trap 'echo "Bash startup check failed at line $LINENO" >&2' ERR
[[ "$CLOUD_STARTUP_PRESERVED" == ready ]]
[[ "$(command -v bun)" == "/opt/stll-cloud/bun/$BUN_VERSION/bun" ]]
[[ "$(command -v node)" == "/opt/stll-cloud/node/$NODE_VERSION/bin/node" ]]
[[ "$(bun --version)" == "$BUN_VERSION" ]]
[[ "$(node --version)" == "v$NODE_VERSION" ]]
`;
      for (const shellArgs of [
        ["--login", "-c", verifyShellPath],
        ["-i", "-c", verifyShellPath],
        [
          "--noprofile",
          "--norc",
          "-c",
          `. "$HOME/.bashrc"\n${verifyShellPath}`,
        ],
      ])
        await root(
          [
            "runuser",
            "-u",
            username,
            "--",
            "env",
            "-i",
            `HOME=${home}`,
            `PATH=${staleRuntimeBin}:${freshShellPath}`,
            `BUN_VERSION=${policy.bun}`,
            `NODE_VERSION=${nodeVersion}`,
            "/bin/bash",
            ...shellArgs,
          ],
          "Fresh Bash startup replaces stale runtime PATH and preserves user settings",
        );
      await root(
        [
          "unshare",
          "--net",
          "--",
          "runuser",
          "-u",
          username,
          "--",
          "env",
          `HOME=${home}`,
          "bash",
          userScript,
          "start",
        ],
        "Nonroot runtime-only startup without a network",
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
    await mkdir(join(fixture, "local-package"), { recursive: true });
    await writeFile(
      join(fixture, "local-package/package.json"),
      JSON.stringify({
        name: "cloud-local-dependency",
        version: "1.0.0",
        main: "index.js",
      }),
    );
    await writeFile(
      join(fixture, "local-package/index.js"),
      "module.exports = 1;\n",
    );
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify({
        name: "cloud-integration",
        private: true,
        packageManager: `bun@${policy.bun}`,
        dependencies: { "cloud-local-dependency": "file:./local-package" },
      }),
    );
    await writeFile(join(fixture, ".node-version"), `${nodeVersion}\n`);
    await writeFile(
      join(fixture, "rust-toolchain.toml"),
      `[toolchain]\nchannel = "${policy.rust}"\nprofile = "minimal"\ncomponents = ["rustfmt", "clippy"]\ntargets = ["wasm32-unknown-unknown"]\n`,
    );
    await writeFile(
      join(fixture, "Cargo.lock"),
      `version = 4\n\n[[package]]\nname = "wasm-bindgen"\nversion = "${cloudSetupArtifacts["wasm-bindgen-cli"].version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`,
    );
    await writeFile(
      join(fixture, "stll-toolchain.json"),
      JSON.stringify({
        optOuts: [],
        cloud: {
          services: ["postgres", "valkey"],
          install: "bun install --frozen-lockfile",
          envFile: "apps/api/.env.test",
          tools: {
            "cargo-nextest": cloudSetupArtifacts["cargo-nextest"].version,
            "wasm-bindgen-cli": cloudSetupArtifacts["wasm-bindgen-cli"].version,
            gitleaks: cloudSetupArtifacts.gitleaks.version,
            uv: cloudSetupArtifacts.uv.version,
            time: cloudSetupPackages.time.version,
          },
        },
      }),
    );
    await command({
      label: "Fixture lockfile generation",
      args: [process.execPath, "install", "--lockfile-only"],
      cwd: fixture,
    });
    await readFile(join(fixture, "bun.lock"));
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
        "local-package",
        "package.json",
        "bun.lock",
        ".node-version",
        "rust-toolchain.toml",
        "Cargo.lock",
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
    await timedCommand({
      label: "Synthetic integration fixture first install",
      args: ["bash", generated, "install"],
    });
    const installedFiles = await freshShell();
    const smoke = join(fixture, "rust-smoke");
    const smokeManifest = join(smoke, "Cargo.toml");
    await mkdir(join(smoke, "src"), { recursive: true });
    await writeFile(
      smokeManifest,
      '[package]\nname = "cloud-setup-smoke"\nversion = "0.1.0"\nedition = "2024"\n\n[lib]\ncrate-type = ["cdylib", "rlib"]\n',
    );
    await writeFile(
      join(smoke, "src/lib.rs"),
      '#[unsafe(no_mangle)]\npub extern "C" fn answer() -> u32 { 42 }\n\n#[test]\nfn executes_native_code() { assert_eq!(answer(), 42); }\n',
    );
    for (const invocation of [
      ["nextest", "run", "--offline"],
      ["build", "--offline", "--target", "wasm32-unknown-unknown"],
    ])
      await command({
        label: "Offline native test and WebAssembly compilation",
        args: [
          "env",
          "-i",
          `HOME=${fixture}`,
          `PATH=${freshShellPath}`,
          "cargo",
          ...invocation,
          "--manifest-path",
          smokeManifest,
        ],
        cwd: fixture,
      });
    await timedCommand({
      label: "Synthetic integration fixture cached install",
      args: ["bash", generated, "install"],
    });
    assert(
      (await freshShell()) === installedFiles,
      "Cached installation replaced pinned runtime or tool files",
    );
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
        lines.length === 10 &&
        lines.at(9) === "",
      "Generated environment shape differs",
    );
    const database = lines.find((line) => line.startsWith("DATABASE_URL="));
    const postgresHost = lines.find((line) =>
      line.startsWith("POSTGRES_HOST="),
    );
    const postgresUser = lines.find((line) =>
      line.startsWith("POSTGRES_USER="),
    );
    const postgresPassword = lines.find((line) =>
      line.startsWith("POSTGRES_PASSWORD="),
    );
    const postgresDatabase = lines.find((line) =>
      line.startsWith("POSTGRES_DB_NAME="),
    );
    const postgresAdditional = lines.find((line) =>
      line.startsWith("POSTGRES_ADDITIONAL_CONNECTION_DATA="),
    );
    const redis = lines.find((line) => line.startsWith("REDIS_URL="));
    assert(
      database !== undefined &&
        postgresHost === "POSTGRES_HOST=127.0.0.1:55432" &&
        postgresUser === "POSTGRES_USER=stll_cloud" &&
        postgresPassword !== undefined &&
        postgresDatabase === "POSTGRES_DB_NAME=cloud_test" &&
        postgresAdditional === "POSTGRES_ADDITIONAL_CONNECTION_DATA=" &&
        redis !== undefined,
      "Generated service connection variables differ",
    );
    if (
      database === undefined ||
      postgresHost === undefined ||
      postgresUser === undefined ||
      postgresPassword === undefined ||
      postgresDatabase === undefined ||
      postgresAdditional === undefined ||
      redis === undefined
    )
      throw new Error("Service connections are absent");
    const databaseUrlText = database.slice("DATABASE_URL=".length);
    const postgresPasswordText = postgresPassword.slice(
      "POSTGRES_PASSWORD=".length,
    );
    const postgresUserText = postgresUser.slice("POSTGRES_USER=".length);
    const postgresHostText = postgresHost.slice("POSTGRES_HOST=".length);
    const postgresDatabaseText = postgresDatabase.slice(
      "POSTGRES_DB_NAME=".length,
    );
    const postgresAdditionalText = postgresAdditional.slice(
      "POSTGRES_ADDITIONAL_CONNECTION_DATA=".length,
    );
    const postgresUrlFromParts =
      `postgres://${postgresUserText}:${postgresPasswordText}@` +
      `${postgresHostText}/${postgresDatabaseText}${postgresAdditionalText}`;
    let postgresUrlFromPartsParsed: URL;
    try {
      databaseUrl = new URL(databaseUrlText);
      postgresUrlFromPartsParsed = new URL(postgresUrlFromParts);
      redisUrl = new URL(redis.slice("REDIS_URL=".length));
    } catch {
      throw new Error("Generated local connection syntax is invalid");
    }
    assert(
      databaseUrl.protocol === "postgresql:" &&
        postgresUrlFromPartsParsed.protocol === "postgres:" &&
        databaseUrl.hostname === postgresUrlFromPartsParsed.hostname &&
        databaseUrl.port === postgresUrlFromPartsParsed.port &&
        databaseUrl.username === postgresUrlFromPartsParsed.username &&
        databaseUrl.password === postgresUrlFromPartsParsed.password &&
        databaseUrl.pathname === postgresUrlFromPartsParsed.pathname &&
        databaseUrl.search === postgresUrlFromPartsParsed.search &&
        databaseUrl.hash === postgresUrlFromPartsParsed.hash,
      "DATABASE_URL must identify the endpoint assembled from PostgreSQL components",
    );
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
      (await pgQuery("SHOW unix_socket_directories")) === "",
      "PostgreSQL Unix sockets must be disabled",
    );
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
    await stalePidRestart();
    assert(
      (await readEnvironment()) === environment,
      "Cached identifier restart changed local environment",
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
