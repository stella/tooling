/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sequence = "bash scripts/verify-release.sh";
const script = await readFile(
  new URL("./verify-release.sh", import.meta.url),
  "utf8",
);

test("Publish and PR CI verify through the same sequence before any build", async () => {
  for (const [filename, job] of [
    ["publish.yml", "verify"],
    ["ci.yml", "build-checks"],
  ]) {
    const workflow: unknown = Bun.YAML.parse(
      await readFile(
        new URL(`../.github/workflows/${filename}`, import.meta.url),
        "utf8",
      ),
    );
    if (!isRecord(workflow) || !isRecord(workflow["jobs"]))
      throw new Error(`${filename}: missing jobs`);
    const verification = workflow["jobs"][job];
    if (!isRecord(verification) || !Array.isArray(verification["steps"]))
      throw new Error(`${filename}: missing verification steps`);
    const commands = verification["steps"].flatMap((step: unknown) => {
      if (!isRecord(step)) return [];
      const run = step["run"];
      return typeof run === "string" ? [run] : [];
    });
    expect(commands.filter((command) => command === sequence)).toHaveLength(1);
    expect(commands.slice(0, commands.indexOf(sequence))).toEqual([
      "bun install --frozen-lockfile",
    ]);
    // Duplicated verification commands would allow the workflows to drift again.
    expect(
      commands.filter((command) =>
        /^bun run (?:build|test|typecheck|lint|publint|check:lockfile-versions|check:registry-versions)$/.test(
          command,
        ),
      ),
    ).toEqual([]);
  }
});

test("verification discards stale outputs, builds before tests and stops on build failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "release-verification-"));
  try {
    await mkdir(path.join(directory, "scripts"));
    await mkdir(path.join(directory, "bin"));
    await writeFile(path.join(directory, "scripts/verify-release.sh"), script);
    await writeFile(
      path.join(directory, "bin/bun"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> commands.log
if [[ "$*" == "run build" ]]; then
  test ! -e packages/oxlint-config/dist
  test ! -e packages/oxlint-plugin/dist
  if [[ "$FAIL_BUILD" == "yes" ]]; then exit 23; fi
  mkdir -p packages/oxlint-config/dist packages/oxlint-plugin/dist
  touch packages/oxlint-config/dist/built
fi
if [[ "$*" == "run test" ]]; then test -f packages/oxlint-config/dist/built; fi
`,
      { mode: 0o755 },
    );
    for (const failBuild of ["no", "yes"]) {
      for (const name of ["oxlint-config", "oxlint-plugin"]) {
        await mkdir(path.join(directory, "packages", name, "dist"), {
          recursive: true,
        });
        await writeFile(
          path.join(directory, "packages", name, "dist/stale"),
          "stale",
        );
      }
      await writeFile(path.join(directory, "commands.log"), "");
      const result = spawnSync("bash", ["scripts/verify-release.sh"], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}/bin:${process.env["PATH"]}`,
          FAIL_BUILD: failBuild,
        },
        encoding: "utf8",
      });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      const commands = (
        await readFile(path.join(directory, "commands.log"), "utf8")
      )
        .trim()
        .split("\n");
      if (failBuild === "yes") {
        expect(result.status).toBe(23);
        expect(commands).toEqual(["run build"]);
        continue;
      }
      expect(result.status).toBe(0);
      expect(commands.at(0)).toBe("run build");
      expect(commands.indexOf("run test")).toBeGreaterThan(
        commands.indexOf("run build"),
      );
      expect(commands.at(-1)).toBe("run publint");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
