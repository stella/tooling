/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import policyInput from "../toolchain.json";
import { cloudSetupPath, generateCloudSetup } from "./cloud-setup";
import {
  cloudClaudeSettingsPath,
  cloudAttributionFix,
  cloudSessionStartFix,
  hasCloudAttribution,
  hasCloudSessionStartHook,
} from "./cloud-setup-claude";
import { parseCloudSetup } from "./cloud-setup-schema";
import { checkToolchain } from "./toolchain-guard";
import { parseToolchainPolicy } from "./toolchain-schema";

const cli = fileURLToPath(new URL("./cloud-setup-cli.ts", import.meta.url));
const invoke = (root: string, args: string[] = []) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
const declaration = {
  services: [],
  install: "bun install --frozen-lockfile",
};
const withRepository = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-cli-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    await writeFile(
      join(root, "stll-toolchain.json"),
      JSON.stringify({ optOuts: [], cloud: declaration }),
    );
    await writeFile(join(root, ".node-version"), "26.10.0\n");
    execFileSync("git", ["add", "."], { cwd: root });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("cloud CLI generates byte-stable executable output shared with the mandatory guard", async () => {
  await withRepository(async (root) => {
    const cloud = parseCloudSetup(declaration);
    if (cloud === undefined) throw new Error("Missing cloud declaration");
    const expected = generateCloudSetup({
      policy: parseToolchainPolicy(policyInput),
      cloud,
      nodeVersion: "26.10.0",
    });
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const result = invoke(root);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(await readFile(join(root, cloudSetupPath), "utf8")).toBe(expected);
      expect((await stat(join(root, cloudSetupPath))).mode & 0o777).toBe(0o755);
    }
    expect(
      hasCloudSessionStartHook(
        await readFile(join(root, cloudClaudeSettingsPath), "utf8"),
      ),
    ).toBe(true);
    execFileSync("git", ["add", cloudSetupPath, cloudClaudeSettingsPath], {
      cwd: root,
    });
    expect(
      checkToolchain({ root, policy: parseToolchainPolicy(policyInput) }),
    ).toEqual([]);
  });
});

test("cloud CLI refuses symlinks and hard links without modifying outside targets", async () => {
  for (const target of ["parent", "destination", "hard-link"]) {
    await withRepository(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "cloud-cli-outside-"));
      try {
        const sentinel = join(outside, "script.sh");
        await writeFile(sentinel, "unchanged");
        if (target === "parent")
          await symlink(outside, join(root, ".agents"), "dir");
        else {
          await mkdir(join(root, ".agents"));
          if (target === "hard-link")
            await link(sentinel, join(root, cloudSetupPath));
          else await symlink(sentinel, join(root, cloudSetupPath));
        }
        const result = invoke(root);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("cloud setup");
        expect(await readFile(sentinel, "utf8")).toBe("unchanged");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  }
});

test("cloud CLI requires tracked declarations and an exact root Node patch", async () => {
  for (const mutation of ["untracked", "no-cloud", "node-series"]) {
    await withRepository(async (root) => {
      if (mutation === "untracked")
        execFileSync("git", ["rm", "--cached", "stll-toolchain.json"], {
          cwd: root,
        });
      if (mutation === "no-cloud")
        await writeFile(join(root, "stll-toolchain.json"), '{"optOuts":[]}');
      if (mutation === "node-series")
        await writeFile(join(root, ".node-version"), "26.x");
      expect(invoke(root).status).toBe(1);
    });
  }
});

test("cloud CLI help succeeds outside a repository and unknown arguments fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-cli-help-"));
  try {
    const help = invoke(root, ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: stll-cloud-setup");
    expect(help.stderr).toBe("");
    for (const args of [["--unknown"], ["--check"], ["--help", "extra"]]) {
      const result = invoke(root, args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage:");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cloud CLI safely merges existing untracked Claude settings without replacing unrelated configuration", async () => {
  await withRepository(async (root) => {
    await mkdir(join(root, ".claude"));
    const original = { permissions: { allow: ["Read"] }, hooks: { Stop: [] } };
    await writeFile(
      join(root, cloudClaudeSettingsPath),
      JSON.stringify(original),
    );
    await chmod(join(root, cloudClaudeSettingsPath), 0o600);
    expect(invoke(root).status).toBe(0);
    expect((await stat(join(root, cloudClaudeSettingsPath))).mode & 0o777).toBe(
      0o600,
    );
    const settings = await readFile(
      join(root, cloudClaudeSettingsPath),
      "utf8",
    );
    expect(JSON.parse(settings)).toMatchObject(original);
    expect(hasCloudSessionStartHook(settings)).toBe(true);
    expect(hasCloudAttribution(settings)).toBe(true);
    expect(invoke(root).status).toBe(0);
    expect(await readFile(join(root, cloudClaudeSettingsPath), "utf8")).toBe(
      settings,
    );
  });
});

test("cloud CLI leaves outputs untouched when Claude settings cannot be safely merged", async () => {
  for (const input of [
    "{invalid",
    '{"hooks":[]}',
    '{"disableAllHooks":true}',
    '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"bash .agents/cloud-setup.sh start"}]}]}}',
  ]) {
    await withRepository(async (root) => {
      await mkdir(join(root, ".claude"));
      await mkdir(join(root, ".agents"));
      await writeFile(join(root, cloudClaudeSettingsPath), input);
      await writeFile(join(root, cloudSetupPath), "existing script");
      const result = invoke(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(cloudSessionStartFix);
      expect(await readFile(join(root, cloudClaudeSettingsPath), "utf8")).toBe(
        input,
      );
      expect(await readFile(join(root, cloudSetupPath), "utf8")).toBe(
        "existing script",
      );
    });
  }
});

test("cloud CLI leaves outputs untouched when existing attribution conflicts", async () => {
  await withRepository(async (root) => {
    const input = JSON.stringify({ attribution: { commit: "custom", pr: "" } });
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, cloudClaudeSettingsPath), input);
    const result = invoke(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(cloudAttributionFix);
    expect(await readFile(join(root, cloudClaudeSettingsPath), "utf8")).toBe(
      input,
    );
  });
});

test("cloud CLI refuses linked Claude settings and parents without writing outside targets", async () => {
  for (const target of [
    "parent",
    "destination",
    "tracked-destination",
    "hard-link",
  ]) {
    await withRepository(async (root) => {
      const outside = await mkdtemp(
        join(tmpdir(), "cloud-cli-settings-outside-"),
      );
      try {
        const sentinel = join(outside, "settings.json");
        await writeFile(sentinel, "{}");
        if (target === "parent")
          await symlink(outside, join(root, ".claude"), "dir");
        else {
          await mkdir(join(root, ".claude"));
          if (target === "hard-link")
            await link(sentinel, join(root, cloudClaudeSettingsPath));
          else await symlink(sentinel, join(root, cloudClaudeSettingsPath));
        }
        if (target === "tracked-destination")
          execFileSync("git", ["add", cloudClaudeSettingsPath], { cwd: root });
        const result = invoke(root);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(cloudSessionStartFix);
        expect(await readFile(sentinel, "utf8")).toBe("{}");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  }
});

test("Rust and tool input changes cannot silently retain a clean cloud drift check", async () => {
  await withRepository(async (root) => {
    const policy = parseToolchainPolicy(policyInput);
    const rustSource = `[toolchain]\nchannel = "${policy.rust}"\nprofile = "minimal"\ncomponents = ["clippy"]\ntargets = ["wasm32-unknown-unknown"]\n`;
    const lockSource =
      'version = 4\n[[package]]\nname = "wasm-bindgen"\nversion = "0.2.126"\n';
    const configuration = {
      cloud: {
        ...declaration,
        tools: { "wasm-bindgen-cli": "0.2.126" },
      },
    };
    await writeFile(
      join(root, "stll-toolchain.json"),
      JSON.stringify(configuration),
    );
    await writeFile(join(root, "rust-toolchain.toml"), rustSource);
    await writeFile(join(root, "Cargo.lock"), lockSource);
    execFileSync("git", ["add", "."], { cwd: root });
    expect(invoke(root).status).toBe(0);
    execFileSync("git", ["add", cloudSetupPath, cloudClaudeSettingsPath], {
      cwd: root,
    });
    const drift = () =>
      checkToolchain({ root, policy }).filter(
        ({ rule }) => rule === "cloud-setup-drift",
      );
    expect(drift()).toEqual([]);
    const mutations = [
      {
        file: "rust-toolchain.toml",
        text: rustSource.replace('["clippy"]', '["clippy", "rustfmt"]'),
        restore: rustSource,
      },
      {
        file: "rust-toolchain.toml",
        text: rustSource.replace(
          "wasm32-unknown-unknown",
          "wasm32-wasip1-threads",
        ),
        restore: rustSource,
      },
      {
        file: "Cargo.lock",
        text: lockSource.replace("0.2.126", "0.2.125"),
        restore: lockSource,
      },
      {
        file: "stll-toolchain.json",
        text: JSON.stringify({
          cloud: { ...configuration.cloud, rust: { components: ["rust-src"] } },
        }),
        restore: JSON.stringify(configuration),
      },
    ];
    for (const { file, text, restore } of mutations) {
      await writeFile(join(root, file), text);
      expect(drift().length).toBeGreaterThan(0);
      await writeFile(join(root, file), restore);
      expect(drift()).toEqual([]);
    }
  });
});
