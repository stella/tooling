/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cloudAttribution,
  cloudAttributionFix,
  cloudSessionStartFix,
  cloudSessionStartHook,
  hasCloudAttribution,
  hasCloudSessionStartHook,
  mergeCloudClaudeSettings,
} from "./cloud-setup-claude";
import { cloudShellProfilePath } from "./cloud-setup-shell";

const settingsWith = (entries: readonly unknown[]) =>
  JSON.stringify({
    attribution: cloudAttribution,
    hooks: { SessionStart: entries },
  });
// The exact hook @stll/oxlint-config 1.1.0 committed into consumer settings.
const releasedHook = {
  matcher: "",
  hooks: [
    {
      type: "command",
      command: `if [ "\${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  bash .agents/cloud-setup.sh start || exit "$?"
  if [ -n "\${CLAUDE_ENV_FILE:-}" ]; then
    if [ ! -f /etc/profile.d/stll-cloud.sh ]; then
      printf '%s\\n' 'cloud-setup: cloud shell profile is unavailable; run install' >&2
      exit 1
    fi
    printf '\\n' >> "$CLAUDE_ENV_FILE" || exit "$?"
    cat /etc/profile.d/stll-cloud.sh >> "$CLAUDE_ENV_FILE"
  fi
fi`,
    },
  ],
};

// The exact project-root hook emitted by 1.3.1 into persisted consumer settings.
const relativeCommand = releasedHook.hooks.at(0)?.command;
if (relativeCommand === undefined)
  throw new Error("Released hook fixture missing");
const releasedProjectHook = {
  matcher: "",
  hooks: [
    {
      type: "command",
      command: relativeCommand.replace(
        "bash .agents/cloud-setup.sh",
        'bash "$CLAUDE_PROJECT_DIR/.agents/cloud-setup.sh"',
      ),
    },
  ],
};

// Exact SessionStart hook persisted by tooling main at 783bc97.
const previouslyCurrentHook = {
  matcher: "",
  hooks: [
    {
      type: "command",
      command: `if [ "\${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  cloud_setup_incomplete() {
    printf '%s\\n' 'Cloud setup could not establish a verified session environment. From the repository root, run bash .agents/cloud-setup.sh install and then bash .agents/cloud-setup.sh start. Do not assume pinned tools or services are ready until start succeeds.'
    printf '%s\\n' "cloud-setup: $1" >&2
    exit 0
  }
  bash "$CLAUDE_PROJECT_DIR/.agents/cloud-setup.sh" start >&2 || cloud_setup_incomplete 'startup failed; run install'
  if [ -n "\${CLAUDE_ENV_FILE:-}" ]; then
    if [ ! -s /etc/profile.d/stll-cloud.sh ]; then
      cloud_setup_incomplete 'cloud shell profile is unavailable; run install'
    fi
    cloud_shell_exports="$(cat /etc/profile.d/stll-cloud.sh)" || cloud_setup_incomplete 'cloud shell profile could not be read; run install'
    [ -n "$cloud_shell_exports" ] || cloud_setup_incomplete 'cloud shell profile is unavailable; run install'
    printf '\\n%s\\n' "$cloud_shell_exports" >> "$CLAUDE_ENV_FILE" || cloud_setup_incomplete 'session environment could not be persisted; check its write access and rerun start'
  fi
fi`,
    },
  ],
};

test("Claude settings merge preserves unrelated settings and reaches a byte-stable fixed point", () => {
  const unrelated = {
    permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] },
    env: { EXAMPLE: "value" },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      SessionStart: [
        {
          matcher: "startup",
          hooks: [{ type: "command", command: "echo existing" }],
        },
      ],
    },
  };
  for (const input of [
    undefined,
    "{}",
    JSON.stringify(unrelated),
    JSON.stringify({ attribution: cloudAttribution }),
    JSON.stringify({ hooks: { SessionStart: [cloudSessionStartHook] } }),
  ]) {
    const merged = mergeCloudClaudeSettings(input);
    expect(hasCloudSessionStartHook(merged)).toBe(true);
    expect(hasCloudAttribution(merged)).toBe(true);
    expect(mergeCloudClaudeSettings(merged)).toBe(merged);
  }
  expect(
    JSON.parse(mergeCloudClaudeSettings(JSON.stringify(unrelated))),
  ).toEqual({
    ...unrelated,
    attribution: { commit: "", pr: "" },
    hooks: {
      ...unrelated.hooks,
      SessionStart: [...unrelated.hooks.SessionStart, cloudSessionStartHook],
    },
  });
  const compact = settingsWith([cloudSessionStartHook]);
  expect(mergeCloudClaudeSettings(compact)).toBe(compact);
}, 15_000);

test("Claude settings merge replaces shipped exact hook forms in place and reaches a fixed point", () => {
  const unrelated = {
    matcher: "startup",
    hooks: [{ type: "command", command: "echo existing" }],
  };
  for (const previous of [
    releasedHook,
    releasedProjectHook,
    previouslyCurrentHook,
  ]) {
    const merged = mergeCloudClaudeSettings(
      JSON.stringify({
        env: { EXAMPLE: "value" },
        hooks: { SessionStart: [previous, unrelated] },
      }),
    );
    expect(JSON.parse(merged)).toEqual({
      env: { EXAMPLE: "value" },
      attribution: cloudAttribution,
      hooks: { SessionStart: [cloudSessionStartHook, unrelated] },
    });
    expect(mergeCloudClaudeSettings(merged)).toBe(merged);
    expect(hasCloudSessionStartHook(settingsWith([previous]))).toBe(false);
    expect(() =>
      mergeCloudClaudeSettings(settingsWith([previous, cloudSessionStartHook])),
    ).toThrow(cloudSessionStartFix);
  }
  expect(() =>
    mergeCloudClaudeSettings(settingsWith([releasedHook, releasedProjectHook])),
  ).toThrow(cloudSessionStartFix);
  expect(() =>
    mergeCloudClaudeSettings(
      settingsWith([
        {
          ...releasedProjectHook,
          matcher: "startup",
        },
      ]),
    ),
  ).toThrow(cloudSessionStartFix);
}, 15_000);

test("Claude attribution conflicts fail with the exact manual fix and drift rejects them", () => {
  const hooks = { SessionStart: [cloudSessionStartHook] };
  for (const attribution of [
    null,
    "",
    {},
    { commit: "" },
    { commit: "", pr: "", extra: "" },
    { commit: "Co-Authored-By: tool", pr: "" },
    { commit: "", pr: "generated" },
  ]) {
    const input = JSON.stringify({ attribution, hooks });
    expect(() => mergeCloudClaudeSettings(input)).toThrow(cloudAttributionFix);
    expect(hasCloudAttribution(input)).toBe(false);
    expect(hasCloudSessionStartHook(input)).toBe(true);
  }
  expect(hasCloudAttribution(undefined)).toBe(false);
  expect(hasCloudAttribution(JSON.stringify({ hooks }))).toBe(false);
  expect(cloudAttributionFix).toContain(
    JSON.stringify({ attribution: { commit: "", pr: "" } }, null, 2),
  );
}, 15_000);

test("Claude hook unsafe merges fail with the exact manual fix and drift rejects them", () => {
  const unguarded = {
    hooks: [{ type: "command", command: "bash .agents/cloud-setup.sh start" }],
  };
  const invalid = [
    "{",
    '{"env":{},"env":{"EXAMPLE":"value"}}',
    '{"unrelated":9007199254740993}',
    '{"unrelated":1e400}',
    "[]",
    "null",
    '{"hooks":null}',
    '{"hooks":[]}',
    '{"hooks":{"SessionStart":null}}',
    '{"hooks":{"SessionStart":{}}}',
    '{"hooks":{"SessionStart":[null]}}',
    '{"disableAllHooks":true}',
    settingsWith([unguarded]),
    settingsWith([{ ...cloudSessionStartHook, matcher: "startup" }]),
    settingsWith([cloudSessionStartHook, cloudSessionStartHook]),
    settingsWith([
      {
        ...cloudSessionStartHook,
        hooks: [
          ...cloudSessionStartHook.hooks,
          { type: "command", command: "echo extra" },
        ],
      },
    ]),
    settingsWith([{ ...previouslyCurrentHook, matcher: "startup" }]),
  ];
  for (const input of invalid) {
    expect(() => mergeCloudClaudeSettings(input)).toThrow(cloudSessionStartFix);
    expect(hasCloudSessionStartHook(input)).toBe(false);
  }
  expect(hasCloudSessionStartHook(undefined)).toBe(false);
  expect(hasCloudSessionStartHook("{}")).toBe(false);
}, 15_000);

test("Claude SessionStart reports remote startup failure as visible context and leaves local sessions silent", () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-claude-hook-"));
  try {
    mkdirSync(join(root, ".agents"));
    writeFileSync(
      join(root, ".agents/cloud-setup.sh"),
      'printf "%s\\n" "$1" >> calls\nexit 7\n',
    );
    const command = cloudSessionStartHook.hooks[0].command;
    for (const remote of [undefined, "", "false", "1", "TRUE", "true"]) {
      const env = { ...process.env };
      delete env["CLAUDE_CODE_REMOTE"];
      delete env["CLAUDE_ENV_FILE"];
      env["CLAUDE_PROJECT_DIR"] = root;
      if (remote !== undefined) env["CLAUDE_CODE_REMOTE"] = remote;
      const result = spawnSync("bash", ["-c", command], { cwd: root, env });
      expect(result.status).toBe(0);
      if (remote === "true") {
        expect(result.stdout.toString()).toContain(
          "Cloud setup could not establish a verified session environment",
        );
        expect(result.stdout.toString()).toContain(
          "bash .agents/cloud-setup.sh install",
        );
        expect(result.stdout.toString()).toContain(
          "bash .agents/cloud-setup.sh start",
        );
        expect(result.stderr.toString()).toContain("startup failed");
      } else {
        expect(result.stdout.toString()).toBe("");
        expect(result.stderr.toString()).toBe("");
      }
    }
    expect(readFileSync(join(root, "calls"), "utf8")).toBe("start\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("remote Claude SessionStart resolves the setup script from the project root in a subdirectory", () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-claude-subdirectory-"));
  try {
    const subdirectory = join(root, "packages/example");
    mkdirSync(join(root, ".agents"));
    mkdirSync(subdirectory, { recursive: true });
    writeFileSync(
      join(root, ".agents/cloud-setup.sh"),
      'printf "%s %s\\n" "$1" "$PWD" >> "$CLAUDE_PROJECT_DIR/calls"\n',
    );
    const profile = join(root, "stll-cloud.sh");
    const environment = join(root, "claude.env");
    const exports = "export CLOUD_HOOK_SUBDIRECTORY=ready\n";
    writeFileSync(profile, exports);
    writeFileSync(environment, "");
    const command = cloudSessionStartHook.hooks[0].command.replaceAll(
      cloudShellProfilePath,
      profile,
    );
    const env = { ...process.env, CLAUDE_ENV_FILE: environment };
    const result = spawnSync("bash", ["-c", command], {
      cwd: subdirectory,
      env: { ...env, CLAUDE_CODE_REMOTE: "true", CLAUDE_PROJECT_DIR: root },
      encoding: "utf8",
    });
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "calls"), "utf8")).toBe(
      `session ${realpathSync(subdirectory)}\n`,
    );
    expect(readFileSync(environment, "utf8")).toBe(
      `\n. '${environment}.stll-cloud'\n`,
    );
    expect(readFileSync(`${environment}.stll-cloud`, "utf8")).toBe(exports);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("Claude SessionStart persists literal pinned exports after start while retaining the future shell PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-claude-environment-"));
  try {
    const pinned = join(root, "pinned");
    const inherited = [join(root, "old-bun"), join(root, "old-node")];
    const environment = join(root, "claude.env");
    const profile = join(root, "stll-cloud.sh");
    mkdirSync(join(root, ".agents"));
    const tools = ["bun", "node", "rustc", "cargo", "uv"];
    for (const directory of [pinned, ...inherited]) {
      mkdirSync(directory);
      for (const tool of tools)
        writeFileSync(join(directory, tool), "#!/bin/sh\nexit 0\n", {
          mode: 0o755,
        });
    }
    writeFileSync(
      join(root, ".agents/cloud-setup.sh"),
      [
        "printf '%s\\n' \"$1\" >> calls",
        'if [ "$1" = session ]; then',
        '  [ "${START_EXIT:-0}" = 0 ] || exit "$START_EXIT"',
        '  printf "%s\\n" "export DATABASE_URL=\'postgres://stll_cloud:fixture-secret@127.0.0.1:55432/cloud_test\'"',
        "  exit 0",
        "fi",
        'exit "${START_EXIT:-0}"',
        "",
      ].join("\n"),
    );
    const exports = `export PATH="${pinned}:$PATH"\nexport RUSTUP_HOME="${root}/rustup"\n`;
    writeFileSync(profile, exports);
    const command = cloudSessionStartHook.hooks[0].command.replaceAll(
      cloudShellProfilePath,
      profile,
    );
    const original = "export KEEP=retained";
    const snapshot = `${environment}.stll-cloud`;
    const source = `. '${snapshot}'\n`;
    const sessionExports = `export DATABASE_URL='postgres://stll_cloud:fixture-secret@127.0.0.1:55432/cloud_test'\n${exports}`;
    const env = {
      ...process.env,
      PATH: [...inherited, "/usr/bin", "/bin"].join(":"),
      CLAUDE_ENV_FILE: environment,
      CLAUDE_PROJECT_DIR: root,
    };
    for (const remote of ["", "false", "TRUE", "true"]) {
      writeFileSync(environment, original);
      const result = spawnSync("/bin/bash", ["-c", command], {
        cwd: root,
        env: { ...env, CLAUDE_CODE_REMOTE: remote },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(readFileSync(environment, "utf8")).toBe(
        remote === "true" ? `${original}\n${source}` : original,
      );
      expect(result.stdout).not.toContain("fixture-secret");
      expect(result.stderr).not.toContain("fixture-secret");
    }
    // A later start (resume, clear, compact) refreshes only its snapshot and
    // keeps whatever other hooks appended to the shared file.
    writeFileSync(
      environment,
      `${readFileSync(environment, "utf8")}export LATER=kept\n`,
    );
    const rerun = spawnSync("/bin/bash", ["-c", command], {
      cwd: root,
      env: { ...env, CLAUDE_CODE_REMOTE: "true" },
      encoding: "utf8",
    });
    expect(rerun.status).toBe(0);
    expect(readFileSync(environment, "utf8")).toBe(
      `${original}\n${source}export LATER=kept\n`,
    );
    expect(readFileSync(snapshot, "utf8")).toBe(sessionExports);
    const persisted = readFileSync(snapshot, "utf8");
    expect(persisted).toContain("$PATH");
    for (const directory of inherited)
      expect(persisted).not.toContain(directory);
    const future = spawnSync(
      "/bin/bash",
      [
        "-c",
        '. "$CLAUDE_ENV_FILE"; command -v bun node rustc cargo uv; printf "%s\\n" "$KEEP" "$RUSTUP_HOME" "$PATH"',
      ],
      { cwd: root, env, encoding: "utf8" },
    );
    expect(future.status).toBe(0);
    expect(future.stdout.split("\n")).toEqual([
      ...tools.map((tool) => join(pinned, tool)),
      "retained",
      join(root, "rustup"),
      `${pinned}:${env.PATH}`,
      "",
    ]);
    expect(readFileSync(join(root, "calls"), "utf8")).toBe(
      "session\nsession\n",
    );

    writeFileSync(environment, original);
    const failed = spawnSync("/bin/bash", ["-c", command], {
      cwd: root,
      env: { ...env, CLAUDE_CODE_REMOTE: "true", START_EXIT: "7" },
    });
    expect(failed.status).toBe(0);
    expect(failed.stdout.toString()).toContain(
      "Cloud setup could not establish a verified session environment",
    );
    expect(failed.stderr.toString()).toContain("startup failed");
    expect(readFileSync(environment, "utf8")).toBe(original);

    for (const content of [undefined, "", "\n"]) {
      if (content === undefined) rmSync(profile);
      else writeFileSync(profile, content);
      const missing = spawnSync("/bin/bash", ["-c", command], {
        cwd: root,
        env: { ...env, CLAUDE_CODE_REMOTE: "true" },
        encoding: "utf8",
      });
      expect(missing.status).toBe(0);
      expect(missing.stdout).toContain(
        "Cloud setup could not establish a verified session environment",
      );
      expect(missing.stderr).toContain(
        "cloud shell profile is unavailable; run install",
      );
      expect(readFileSync(environment, "utf8")).toBe(original);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("Node settings parse diagnostics use the canonical repair without echoing input", () => {
  const marker = "fixture-settings-source";
  const program = `import { mergeCloudClaudeSettings } from "./src/cloud-setup-claude.ts";
try { mergeCloudClaudeSettings(${JSON.stringify(`${marker} is invalid JSON`)}); process.exitCode = 2; }
catch (error) { process.stdout.write(error.message); }
`;
  const result = spawnSync(
    "node",
    ["--import", "tsx", "--input-type=module", "-e", program],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    },
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("settings must contain valid JSON");
  expect(result.stdout).toContain(cloudSessionStartFix);
  expect(result.stdout).not.toContain(marker);
}, 15_000);

test("SessionStart reads, writes and replacement fail visibly without changing existing environment", () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-claude-write-failure-"));
  try {
    mkdirSync(join(root, ".agents"));
    writeFileSync(
      join(root, ".agents/cloud-setup.sh"),
      "printf '%s\\n' 'fixture-untrusted-start-output'\n",
    );
    const profile = join(root, "stll-cloud.sh");
    const environment = join(root, "claude.env");
    const original = "export KEEP=retained\n";
    writeFileSync(profile, "export FIXTURE_HOOK_SECRET=private-value\n");
    const command = cloudSessionStartHook.hooks[0].command.replaceAll(
      cloudShellProfilePath,
      profile,
    );
    const failures = [
      { failure: "cat() { return 74; }", reason: "could not be read" },
      {
        failure:
          'printf() { if [[ /dev/fd/1 -ef "$CLAUDE_ENV_FILE" ]]; then return 76; fi; builtin printf "$@"; }',
        reason: "could not be persisted",
      },
      {
        failure:
          'printf() { if [[ -n "${cloud_env_temporary:-}" && /dev/fd/1 -ef "$cloud_env_temporary" ]]; then return 73; fi; builtin printf "$@"; }',
        reason: "could not be prepared",
      },
      { failure: "mv() { return 75; }", reason: "could not be persisted" },
    ];
    for (const { failure, reason } of failures) {
      writeFileSync(environment, original);
      const result = spawnSync("bash", ["-c", `${failure}\n${command}`], {
        cwd: root,
        env: {
          ...process.env,
          CLAUDE_CODE_REMOTE: "true",
          CLAUDE_PROJECT_DIR: root,
          CLAUDE_ENV_FILE: environment,
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "Cloud setup could not establish a verified session environment",
      );
      expect(result.stdout).toContain("bash .agents/cloud-setup.sh install");
      expect(result.stdout).not.toContain("fixture-untrusted-start-output");
      expect(result.stdout).not.toContain("private-value");
      expect(result.stderr).toContain(reason);
      expect(readFileSync(environment, "utf8")).toBe(original);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("SessionStart refuses a snapshot destination that is not a regular file instead of publishing into it", () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-claude-snapshot-target-"));
  try {
    mkdirSync(join(root, ".agents"));
    writeFileSync(join(root, ".agents/cloud-setup.sh"), "exit 0\n");
    const profile = join(root, "stll-cloud.sh");
    writeFileSync(profile, "export FIXTURE_SNAPSHOT=ready\n");
    const environment = join(root, "claude.env");
    const snapshot = `${environment}.stll-cloud`;
    const outside = join(root, "outside");
    const original = "export KEEP=retained\n";
    const command = cloudSessionStartHook.hooks[0].command.replaceAll(
      cloudShellProfilePath,
      profile,
    );
    const targets = [
      { name: "directory", create: () => mkdirSync(snapshot) },
      {
        name: "symlink to a directory",
        create: () => symlinkSync(outside, snapshot, "dir"),
      },
      {
        name: "symlink to a file",
        create: () => symlinkSync(join(outside, "file"), snapshot),
      },
    ];
    for (const { name, create } of targets) {
      rmSync(snapshot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      mkdirSync(outside);
      writeFileSync(join(outside, "file"), "unchanged\n");
      writeFileSync(environment, original);
      create();
      const result = spawnSync("bash", ["-c", command], {
        cwd: root,
        env: {
          ...process.env,
          CLAUDE_CODE_REMOTE: "true",
          CLAUDE_PROJECT_DIR: root,
          CLAUDE_ENV_FILE: environment,
        },
        encoding: "utf8",
      });
      expect(result.status, name).toBe(0);
      expect(result.stdout, name).toContain(
        "Cloud setup could not establish a verified session environment",
      );
      expect(result.stderr, name).toContain(
        "session environment snapshot must be a regular file",
      );
      // The shared file gains no source line for a target it cannot load.
      expect(readFileSync(environment, "utf8"), name).toBe(original);
      expect(readdirSync(outside), name).toEqual(["file"]);
      expect(readFileSync(join(outside, "file"), "utf8"), name).toBe(
        "unchanged\n",
      );
      if (name === "directory") expect(readdirSync(snapshot), name).toEqual([]);
      expect(
        readdirSync(root).filter((entry) =>
          entry.startsWith("claude.env.stll-cloud."),
        ),
        name,
      ).toEqual([]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
