import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
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

import { declaredFirstPartyPackages } from "./quarantine-policy";

const cli = fileURLToPath(new URL("./quarantine-cli.ts", import.meta.url));
const invoke = (root: string, args: string[] = []) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
const fixture = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "stll-quarantine-cli-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { "@stll/oxlint-config": "1.4.0" } }),
    );
    execFileSync("git", ["add", "."], { cwd: root });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("preset synchronization initializes before install and converges for untracked output and lock identities", async () => {
  await fixture(async (root) => {
    expect(invoke(root, ["--check"]).status).toBe(1);
    const missingFile = await stat(join(root, "bunfig.toml")).catch(
      (error: unknown) => error,
    );
    expect(missingFile).toHaveProperty("code", "ENOENT");
    const first = invoke(root, ["--sync"]);
    expect(first.status, first.stderr).toBe(0);
    const path = join(root, "bunfig.toml");
    const text = await readFile(path, "utf8");
    expect(text).toContain(
      '"@stll/oxlint-config", # quarantine-excluded-since:',
    );
    expect(text).not.toContain("@stll/*");
    expect(invoke(root).status).toBe(0);
    const before = await stat(path);
    expect(invoke(root, ["--sync"]).status).toBe(0);
    expect(await readFile(path, "utf8")).toBe(text);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    await writeFile(
      join(root, "bun.lock"),
      JSON.stringify({
        packages: { native: ["@stll/native-linux-x64@1.0.0", "", {}] },
      }),
    );
    expect(invoke(root, ["--check"]).status).toBe(1);
    expect(invoke(root, ["--sync"]).status).toBe(0);
    expect(await readFile(path, "utf8")).toContain(
      '"@stll/native-linux-x64", # quarantine-excluded-since:',
    );
    expect(invoke(root, ["--check"]).status).toBe(0);
    await writeFile(join(root, ".npmrc"), "registry=https://example.invalid\n");
    const npmrc = invoke(root);
    expect(npmrc.status).toBe(1);
    expect(npmrc.stderr).toContain(".npmrc");
  });
});

test("prune removes expired third-party exclusions and preserves permanent owned packages", async () => {
  await fixture(async (root) => {
    const output = join(root, "bunfig.toml");
    await writeFile(
      output,
      '[install]\nminimumReleaseAge = 432000\nminimumReleaseAgeExcludes = [\n "@stll/oxlint-config",\n "bun-types", # quarantine-expires: 2020-01-01T00:00:00.000Z\n]\n',
    );
    const pruned = invoke(root, ["--prune"]);
    expect(pruned.status, pruned.stderr).toBe(0);
    expect(await readFile(output, "utf8")).not.toContain("bun-types");
    expect(await readFile(output, "utf8")).toContain("@stll/oxlint-config");
    expect(invoke(root, ["--check"]).status).toBe(0);
  });
});

test("CLI rejects unsafe destinations and invalid arguments before writes", async () => {
  await fixture(async (root) => {
    expect(invoke(root, ["--help"]).status).toBe(0);
    for (const args of [
      ["--bad"],
      ["--sync", "--prune"],
      ["--check", "--check"],
    ])
      expect(invoke(root, args).status).toBe(1);
    const sentinel = join(root, "sentinel");
    await writeFile(sentinel, "unchanged\n");
    for (const kind of ["symbolic", "hard"]) {
      const output = join(root, "bunfig.toml");
      if (kind === "symbolic") await symlink(sentinel, output);
      else await link(sentinel, output);
      expect(invoke(root, ["--sync"]).status).toBe(1);
      expect(await readFile(sentinel, "utf8")).toBe("unchanged\n");
      await rm(output);
    }
  });
});

test("declared first-party identities exclude workspaces and third-party alias targets", () => {
  expect(
    [
      ...declaredFirstPartyPackages({
        "package.json": JSON.stringify({
          dependencies: {
            "@stll/direct": "1.0.0",
            "@stll/local": "workspace:*",
            "@stll/path": "file:./local",
            "@stll/deceptive": "npm:third-party@1.0.0",
            alias: "npm:@stll/actual@1.0.0",
            "@stll/catalog": "catalog:",
          },
        }),
      }),
    ].sort(),
  ).toEqual(["@stll/actual", "@stll/catalog", "@stll/direct"]);
});

test.skipIf(process.env["CI"] !== "true")(
  "published quarantine CLI runs under Node",
  async () => {
    await fixture(async (root) => {
      const built = fileURLToPath(
        new URL("../dist/quarantine-cli.mjs", import.meta.url),
      );
      const write = spawnSync("node", [built, "--sync"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(write.status, write.stderr).toBe(0);
      const check = spawnSync("node", [built, "--check"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(check.status, check.stderr).toBe(0);
    });
  },
);
