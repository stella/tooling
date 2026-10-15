/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cloudSessionStartFix,
  cloudSessionStartHook,
  hasCloudSessionStartHook,
  mergeCloudSessionStartHook,
} from "./cloud-setup-claude";
import { cloudShellProfilePath } from "./cloud-setup-shell";

const settingsWith = (entries: readonly unknown[]) =>
  JSON.stringify({ hooks: { SessionStart: entries } });

test("Claude hook merge preserves unrelated settings and reaches a byte-stable fixed point", () => {
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
  for (const input of [undefined, "{}", JSON.stringify(unrelated)]) {
    const merged = mergeCloudSessionStartHook(input);
    expect(hasCloudSessionStartHook(merged)).toBe(true);
    expect(mergeCloudSessionStartHook(merged)).toBe(merged);
  }
  expect(
    JSON.parse(mergeCloudSessionStartHook(JSON.stringify(unrelated))),
  ).toEqual({
    ...unrelated,
    hooks: {
      ...unrelated.hooks,
      SessionStart: [...unrelated.hooks.SessionStart, cloudSessionStartHook],
    },
  });
  const compact = settingsWith([cloudSessionStartHook]);
  expect(mergeCloudSessionStartHook(compact)).toBe(compact);
});

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
  ];
  for (const input of invalid) {
    expect(() => mergeCloudSessionStartHook(input)).toThrow(
      cloudSessionStartFix,
    );
    expect(hasCloudSessionStartHook(input)).toBe(false);
  }
  expect(hasCloudSessionStartHook(undefined)).toBe(false);
  expect(hasCloudSessionStartHook("{}")).toBe(false);
});

test("Claude SessionStart starts services only for the exact remote environment and preserves failures", () => {
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
      if (remote !== undefined) env["CLAUDE_CODE_REMOTE"] = remote;
      const result = spawnSync("bash", ["-c", command], { cwd: root, env });
      expect(result.status).toBe(remote === "true" ? 7 : 0);
    }
    expect(readFileSync(join(root, "calls"), "utf8")).toBe("start\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
      'printf "%s\\n" "$1" >> calls\nexit "${START_EXIT:-0}"\n',
    );
    const exports = `export PATH="${pinned}:$PATH"\nexport RUSTUP_HOME="${root}/rustup"\n`;
    writeFileSync(profile, exports);
    const command = cloudSessionStartHook.hooks[0].command.replaceAll(
      cloudShellProfilePath,
      profile,
    );
    const original = "export KEEP=retained";
    const env = {
      ...process.env,
      PATH: [...inherited, "/usr/bin", "/bin"].join(":"),
      CLAUDE_ENV_FILE: environment,
    };
    for (const remote of ["", "false", "TRUE", "true"]) {
      writeFileSync(environment, original);
      const result = spawnSync("/bin/bash", ["-c", command], {
        cwd: root,
        env: { ...env, CLAUDE_CODE_REMOTE: remote },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(readFileSync(environment, "utf8")).toBe(
        remote === "true" ? `${original}\n${exports}` : original,
      );
    }
    const persisted = readFileSync(environment, "utf8");
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
    expect(readFileSync(join(root, "calls"), "utf8")).toBe("start\n");

    writeFileSync(environment, original);
    const failed = spawnSync("/bin/bash", ["-c", command], {
      cwd: root,
      env: { ...env, CLAUDE_CODE_REMOTE: "true", START_EXIT: "7" },
    });
    expect(failed.status).toBe(7);
    expect(readFileSync(environment, "utf8")).toBe(original);

    rmSync(profile);
    const missing = spawnSync("/bin/bash", ["-c", command], {
      cwd: root,
      env: { ...env, CLAUDE_CODE_REMOTE: "true" },
      encoding: "utf8",
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      "cloud shell profile is unavailable; run install",
    );
    expect(readFileSync(environment, "utf8")).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Node settings parse diagnostics use the canonical repair without echoing input", () => {
  const marker = "fixture-settings-source";
  const program = `import { mergeCloudSessionStartHook } from "./src/cloud-setup-claude.ts";
try { mergeCloudSessionStartHook(${JSON.stringify(`${marker} is invalid JSON`)}); process.exitCode = 2; }
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
});
