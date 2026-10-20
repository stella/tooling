import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  link,
  mkdir,
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
import { generateDependabotConfig, parseToolchainPolicy } from "./dependabot";
import { checkDependabot } from "./toolchain-dependabot";
import { readToolchainInputs } from "./toolchain-guard";

const cli = fileURLToPath(new URL("./dependabot-cli.ts", import.meta.url));
const invoke = (root: string, args: string[] = []) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
const policy = parseToolchainPolicy(policyInput).dependabot;
const withRepository = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "dependabot-cli-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    await mkdir(join(root, "wasm"));
    await mkdir(join(root, "oracle"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "bun@1.4.3" }),
    );
    await writeFile(
      join(root, "wasm/package.json"),
      JSON.stringify({ dependencies: { runtime: "1.0.0" } }),
    );
    await writeFile(
      join(root, "oracle/Gemfile"),
      "source 'https://rubygems.org'\n",
    );
    await writeFile(join(root, "oracle/composer.json"), "{}\n");
    execFileSync("git", ["add", "."], { cwd: root });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("public generator and write CLI produce the same complete fixed point", async () => {
  await withRepository(async (root) => {
    // Untracked fixtures are not repository dependency declarations.
    await mkdir(join(root, "untracked"));
    await writeFile(join(root, "untracked/composer.json"), "{}\n");
    const expected = generateDependabotConfig({
      files: readToolchainInputs(root).files,
      policy,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = invoke(root);
      expect(result.status, result.stderr).toBe(0);
      expect(await readFile(join(root, ".github/dependabot.yml"), "utf8")).toBe(
        expected,
      );
    }
    execFileSync("git", ["add", ".github/dependabot.yml"], { cwd: root });
    expect(
      checkDependabot({ files: readToolchainInputs(root).files, policy }),
    ).toEqual([]);
    expect(expected).toContain("package-ecosystem: bundler");
    expect(expected).toContain("package-ecosystem: composer");
    expect(expected).toContain("/wasm");
    expect(expected).not.toContain("/untracked");
    expect(
      (await stat(join(root, ".github/dependabot.yml"))).mode & 0o777,
    ).toBe(0o644);
  });
}, 15_000);

test.skipIf(process.env["CI"] !== "true")(
  "published ESM and CommonJS entries export the generator and the built CLI writes it",
  async () => {
    await withRepository(async (root) => {
      const expected = generateDependabotConfig({
        files: readToolchainInputs(root).files,
        policy,
      });
      for (const format of ["mjs", "cjs"]) {
        const entry = fileURLToPath(
          new URL(`../dist/dependabot.${format}`, import.meta.url),
        );
        const result = spawnSync(
          "node",
          [
            "--input-type=module",
            "-e",
            `
          import fs from "node:fs";
          const entry = await import(process.argv[1]);
          const policy = entry.parseToolchainPolicy(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
          process.stdout.write(entry.generateDependabotConfig({ files: JSON.parse(process.argv[3]), policy: policy.dependabot }));
        `,
            entry,
            fileURLToPath(new URL("../toolchain.json", import.meta.url)),
            JSON.stringify(readToolchainInputs(root).files),
          ],
          { encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(expected);
      }
      const built = fileURLToPath(
        new URL("../dist/dependabot-cli.mjs", import.meta.url),
      );
      const result = spawnSync("node", [built], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(await readFile(join(root, ".github/dependabot.yml"), "utf8")).toBe(
        expected,
      );
      const checked = spawnSync("node", [built, "--check"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(checked.status, checked.stderr).toBe(0);
    });
  },
);

test("preserves the existing yaml spelling and rejects conflicting outputs", async () => {
  await withRepository(async (root) => {
    await mkdir(join(root, ".github"));
    await writeFile(join(root, ".github/dependabot.yaml"), "version: 2\n");
    expect(invoke(root).status).toBe(0);
    expect(invoke(root, ["--check"]).status).toBe(0);
    await writeFile(join(root, ".github/dependabot.yml"), "sentinel\n");
    const result = invoke(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exactly one Dependabot configuration");
    expect(await readFile(join(root, ".github/dependabot.yml"), "utf8")).toBe(
      "sentinel\n",
    );
  });
}, 15_000);

test("recreates a deleted tracked output at its indexed spelling", async () => {
  for (const extension of ["yml", "yaml"]) {
    for (const removeParent of [false, true]) {
      await withRepository(async (root) => {
        const relative = `.github/dependabot.${extension}`;
        const output = join(root, relative);
        await mkdir(join(root, ".github"));
        await writeFile(output, "version: 2\n");
        execFileSync("git", ["add", relative], { cwd: root });
        await rm(removeParent ? join(root, ".github") : output, {
          recursive: removeParent,
        });
        const expected = generateDependabotConfig({
          files: readToolchainInputs(root).files,
          policy,
        });
        expect(invoke(root, ["--check"]).status).toBe(1);
        await assert.rejects(stat(output), { code: "ENOENT" });
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = invoke(root);
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain(relative);
          expect(await readFile(output, "utf8")).toBe(expected);
        }
        const alternative = join(
          root,
          `.github/dependabot.${extension === "yml" ? "yaml" : "yml"}`,
        );
        await assert.rejects(stat(alternative), { code: "ENOENT" });
      });
    }
  }
}, 15_000);

test("missing unrelated inputs and conflicting indexed output spellings never write", async () => {
  await withRepository(async (root) => {
    expect(invoke(root).status).toBe(0);
    const output = join(root, ".github/dependabot.yml");
    execFileSync("git", ["add", ".github/dependabot.yml"], { cwd: root });
    const original = await readFile(output, "utf8");
    await rm(join(root, "package.json"));
    const result = invoke(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "package.json: cannot read tracked configuration file",
    );
    expect(await readFile(output, "utf8")).toBe(original);
  });
  await withRepository(async (root) => {
    await mkdir(join(root, ".github"));
    for (const extension of ["yml", "yaml"])
      await writeFile(
        join(root, `.github/dependabot.${extension}`),
        "sentinel\n",
      );
    execFileSync("git", ["add", ".github"], { cwd: root });
    await rm(join(root, ".github/dependabot.yaml"));
    const result = invoke(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exactly one Dependabot configuration");
    expect(await readFile(join(root, ".github/dependabot.yml"), "utf8")).toBe(
      "sentinel\n",
    );
    await assert.rejects(stat(join(root, ".github/dependabot.yaml")), {
      code: "ENOENT",
    });
  });
}, 15_000);

test("help needs no repository and invalid options never write", async () => {
  const root = await mkdtemp(join(tmpdir(), "dependabot-help-"));
  try {
    const help = invoke(root, ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: stll-dependabot");
    for (const args of [["--write"], ["--help", "extra"]]) {
      const result = invoke(root, args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage:");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("generated configuration never overwrites linked external targets", async () => {
  for (const kind of ["parent", "symlink", "hard-link"]) {
    await withRepository(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "dependabot-outside-"));
      try {
        const sentinel = join(outside, "sentinel.yml");
        await writeFile(sentinel, "unchanged\n");
        if (kind === "parent")
          await symlink(outside, join(root, ".github"), "dir");
        else {
          await mkdir(join(root, ".github"));
          const destination = join(root, ".github/dependabot.yml");
          if (kind === "symlink") await symlink(sentinel, destination);
          else await link(sentinel, destination);
        }
        expect(invoke(root).status).toBe(1);
        expect(await readFile(sentinel, "utf8")).toBe("unchanged\n");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  }
}, 15_000);

test("check mode reports absent or stale output without writing and accepts the generated fixed point", async () => {
  await withRepository(async (root) => {
    const output = join(root, ".github/dependabot.yml");
    const absent = invoke(root, ["--check"]);
    expect(absent.status).toBe(1);
    expect(absent.stderr).toContain("has drifted");
    await assert.rejects(stat(join(root, ".github")), { code: "ENOENT" });
    expect(invoke(root).status).toBe(0);
    const generated = await readFile(output, "utf8");
    const before = await stat(output);
    const checked = invoke(root, ["--check"]);
    expect(checked.status, checked.stderr).toBe(0);
    expect((await stat(output)).mtimeMs).toBe(before.mtimeMs);
    await writeFile(output, `${generated}# stale\n`);
    const stale = await stat(output);
    expect(invoke(root, ["--check"]).status).toBe(1);
    expect(await readFile(output, "utf8")).toBe(`${generated}# stale\n`);
    expect((await stat(output)).mtimeMs).toBe(stale.mtimeMs);
  });
}, 15_000);

test("explicit ecosystem declarations use shared policy and check the same generated output", async () => {
  await withRepository(async (root) => {
    const config = "updates.json";
    await writeFile(
      join(root, config),
      JSON.stringify({
        updates: [
          { ecosystem: "bun", directories: ["/wasm", "/"] },
          { ecosystem: "bundler", directories: ["/oracle"] },
          { ecosystem: "composer", directories: ["/oracle"] },
          { ecosystem: "terraform", directories: ["/infra"] },
        ],
      }),
    );
    const written = invoke(root, ["--config", config]);
    expect(written.status, written.stderr).toBe(0);
    const output = await readFile(join(root, ".github/dependabot.yml"), "utf8");
    expect(output).toContain("package-ecosystem: terraform");
    expect(output).toContain("/infra");
    expect(output).toContain(`default-days: ${policy.cooldown.defaultDays}`);
    expect(output).toContain("dependency-name: typescript");
    expect(output).toContain("version-update:semver-major");
    expect(invoke(root, ["--check", "--config", config]).status).toBe(0);
    expect(invoke(root, ["--config", config, "--check"]).status).toBe(0);
    expect(invoke(root, ["--check"]).status).toBe(1);
    expect(await readFile(join(root, ".github/dependabot.yml"), "utf8")).toBe(
      output,
    );
  });
}, 15_000);

test("declarations cannot omit detected coverage or override shared update policy", async () => {
  const invalidInputs: unknown[] = [
    {},
    { updates: [] },
    { updates: [{ ecosystem: "bun", directories: ["/"] }] },
    { updates: [{ ecosystem: "bun", directories: ["/"], schedule: {} }] },
    { updates: [{ ecosystem: "bun", directories: ["/"] }], cooldown: 0 },
    { updates: [{ ecosystem: "bun", directories: ["/", "/"] }] },
    {
      updates: [
        { ecosystem: "bun", directories: ["/"] },
        { ecosystem: "bun", directories: ["/wasm"] },
      ],
    },
    ...[
      "relative",
      "/../outside",
      "/wasm/",
      "/a//b",
      "/a/./b",
      "/**",
      "/a\\b",
    ].map((directory) => ({
      updates: [{ ecosystem: "bun", directories: [directory] }],
    })),
  ];
  await withRepository(async (root) => {
    for (const input of invalidInputs) {
      await writeFile(join(root, "updates.json"), JSON.stringify(input));
      const result = invoke(root, ["--config", "updates.json"]);
      expect(result.status, JSON.stringify(input)).toBe(1);
      await assert.rejects(stat(join(root, ".github")), { code: "ENOENT" });
    }
    for (const args of [
      ["--config"],
      ["--config", "--check"],
      ["--check", "--check"],
      ["--config", "a", "--config", "b"],
    ]) {
      expect(invoke(root, args).status).toBe(1);
    }
  });
}, 15_000);

test("unsupported ecosystem declarations cannot write or validate generated output", async () => {
  await withRepository(async (root) => {
    expect(invoke(root).status).toBe(0);
    const output = join(root, ".github/dependabot.yml");
    const original = await readFile(output, "utf8");
    for (const ecosystem of ["githb-actions", "unknown-ecosystem"]) {
      await writeFile(
        join(root, "updates.json"),
        JSON.stringify({
          updates: [
            { ecosystem: "bun", directories: ["/", "/wasm"] },
            { ecosystem: "bundler", directories: ["/oracle"] },
            { ecosystem: "composer", directories: ["/oracle"] },
            { ecosystem, directories: ["/"] },
          ],
        }),
      );
      for (const mode of [[], ["--check"]]) {
        const result = invoke(root, ["--config", "updates.json", ...mode]);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(
          `unsupported Dependabot ecosystem: ${ecosystem}`,
        );
        expect(await readFile(output, "utf8")).toBe(original);
      }
    }
  });
}, 15_000);

test("the CLI generates and checks tracked stll-toolchain.json Dependabot ignores", async () => {
  await withRepository(async (root) => {
    const graphql = {
      ecosystem: "bun",
      dependency: "graphql",
      updateTypes: ["version-update:semver-major"],
      reason: "Payload 3 requires graphql ^16.",
    };
    const declare = async (configuration: unknown) => {
      await writeFile(
        join(root, "stll-toolchain.json"),
        JSON.stringify(configuration),
      );
      execFileSync("git", ["add", "stll-toolchain.json"], { cwd: root });
    };
    await declare({ dependabotIgnores: [graphql] });
    const written = invoke(root);
    expect(written.status, written.stderr).toBe(0);
    expect(
      await readFile(join(root, ".github/dependabot.yml"), "utf8"),
    ).toContain("dependency-name: graphql");
    execFileSync("git", ["add", ".github/dependabot.yml"], { cwd: root });
    expect(invoke(root, ["--check"]).status).toBe(0);
    await declare({});
    const drifted = invoke(root, ["--check"]);
    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain("has drifted");
    // stll-toolchain-check owns unrelated declarations; they must not block generation.
    const unrelated = {
      optOuts: [{ rule: "unknown-rule", reason: "" }],
      futureDeclaration: true,
    };
    await declare({ ...unrelated, dependabotIgnores: [graphql] });
    const scoped = invoke(root);
    expect(scoped.status, scoped.stderr).toBe(0);
    expect(invoke(root, ["--check"]).status).toBe(0);
    for (const { dependabotIgnores, message } of [
      {
        dependabotIgnores: [{ ...graphql, dependency: "oxlint" }],
        message: "shared pin oxlint",
      },
      {
        dependabotIgnores: [{ ...graphql, reason: " " }],
        message: "nonempty reason",
      },
    ]) {
      await declare({ ...unrelated, dependabotIgnores });
      const rejected = invoke(root);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain(message);
    }
  });
}, 15_000);
