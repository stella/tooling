import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  diagnosticSet,
  insideProbePath,
  runTypecheckProbe,
} from "./typecheck-probe";

type ProjectFixture = { repo: string; project: string; directory: string };
const withProject = async (
  exercise: (fixture: ProjectFixture) => Promise<void>,
) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "typecheck-probe-"));
  const repo = await realpath(temporary);
  const project = "packages/library/tsconfig.json";
  const directory = path.join(repo, "packages/library");
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(repo, project), "{}\n");
    await writeFile(path.join(directory, "existing.ts"), "export {};\n");
    await exercise({ repo, project, directory });
    expect(await readFile(path.join(directory, "existing.ts"), "utf8")).toBe(
      "export {};\n",
    );
    expect((await readdir(directory)).sort()).toEqual([
      "existing.ts",
      "tsconfig.json",
    ]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
};
const seedIn = async (directory: string) => {
  const seeds = (await readdir(directory)).filter((file) =>
    file.startsWith("stll-typecheck-probe-"),
  );
  expect(seeds).toHaveLength(1);
  const seed = seeds.at(0);
  if (seed === undefined) throw new Error("missing probe seed");
  expect(await readFile(path.join(directory, seed), "utf8")).toBe(
    'export const typecheckProbe: number = "wrong";\n',
  );
  return seed;
};
const command = ["typecheck", "--noEmit"] as const;

test("probe requires its own diagnostic, removes the seed and repeats the exact command cleanly", async () => {
  for (const diagnostic of ["tsc", "colon", "xml", "bun-filter"])
    for (const origin of ["repository", "project"])
      await withProject(async ({ repo, project, directory }) => {
        let calls = 0;
        const outputs: string[] = [];
        await runTypecheckProbe({
          repo,
          project,
          command,
          output: (value) => outputs.push(value),
          run: async (options) => {
            expect(options.command).toEqual(command);
            expect(options.cwd).toBe(repo);
            expect(options.signal.aborted).toBe(false);
            calls++;
            if (calls === 2) {
              expect(
                (await readdir(directory)).filter((file) =>
                  file.startsWith("stll-typecheck-probe-"),
                ),
              ).toEqual([]);
              return { status: 0, output: "clean\n" };
            }
            const seed = path.relative(
              origin === "repository" ? repo : directory,
              path.join(directory, await seedIn(directory)),
            );
            if (diagnostic === "xml")
              return {
                status: 1,
                output: `<error file="${seed}" line="1" code="TS2322">Mismatch</error>`,
              };
            if (diagnostic === "colon")
              return {
                status: 1,
                output: `${seed}:1:14: error TS2322: Mismatch`,
              };
            return {
              status: 2,
              output: `\u001b[31m${diagnostic === "bun-filter" ? "@stll/library typecheck: " : ""}${seed}(1,14): error TS2322: Mismatch\u001b[0m`,
            };
          },
        });
        expect(calls).toBe(2);
        expect(outputs).toHaveLength(2);
        expect(outputs.at(-1)).toBe("clean\n");
      });
}, 15_000);

test("successful seeded runs, excluded seeds and unrelated failures never activate the probe", async () => {
  for (const kind of [
    "success",
    "signal",
    "ambient",
    "different-code",
    "different-file",
  ])
    await withProject(async ({ repo, project, directory }) => {
      let calls = 0;
      await assert.rejects(
        runTypecheckProbe({
          repo,
          project,
          command,
          run: async () => {
            calls++;
            const seed = await seedIn(directory);
            if (kind === "success") return { status: 0, output: "" };
            if (kind === "signal") return { status: null, output: "" };
            if (kind === "ambient")
              return {
                status: 1,
                output: "existing.ts(1,1): error TS2322: Mismatch",
              };
            if (kind === "different-file")
              return {
                status: 1,
                output: `other/${seed}(1,1): error TS2322: Mismatch`,
              };
            return {
              status: 1,
              output: `${path.relative(repo, path.join(directory, seed))}(1,1): error TS2304: Missing`,
            };
          },
        }),
        /typecheck probe expected/,
      );
      expect(calls).toBe(1);
    });
}, 15_000);

test("clean failure and command errors remove the owned seed", async () => {
  for (const phase of ["seeded-error", "clean-error", "clean-failure"])
    await withProject(async ({ repo, project, directory }) => {
      let calls = 0;
      await assert.rejects(
        runTypecheckProbe({
          repo,
          project,
          command,
          run: async () => {
            calls++;
            if (
              phase === "seeded-error" ||
              (phase === "clean-error" && calls === 2)
            )
              throw new Error("command unavailable");
            if (calls === 2)
              return { status: 1, output: "clean typecheck failed" };
            return {
              status: 1,
              output: `${path.relative(repo, path.join(directory, await seedIn(directory)))}(1,1): error TS2322: Mismatch`,
            };
          },
        }),
        phase === "clean-failure"
          ? /clean command failed/
          : /command unavailable/,
      );
    });
}, 15_000);

test("interrupts abort pending work, remove the seed and restore process signal listeners", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    await withProject(async ({ repo, project, directory }) => {
      const before = process.listenerCount(signal);
      await assert.rejects(
        runTypecheckProbe({
          repo,
          project,
          command,
          run: async ({ signal: abort }) => {
            await seedIn(directory);
            queueMicrotask(() => process.emit(signal));
            return new Promise<never>((_resolve, reject) =>
              abort.addEventListener(
                "abort",
                () => reject(new Error("aborted runner")),
                { once: true },
              ),
            );
          },
        }),
        new RegExp(`interrupted by ${signal}`),
      );
      expect(process.listenerCount(signal)).toBe(before);
    });
}, 15_000);

test("project containment rejects escaped, external symlink and directory projects before running commands", async () => {
  await withProject(async ({ repo, project }) => {
    const external = await mkdtemp(
      path.join(tmpdir(), "typecheck-probe-external-"),
    );
    try {
      await writeFile(path.join(external, "tsconfig.json"), "{}\n");
      await symlink(
        path.join(external, "tsconfig.json"),
        path.join(repo, "linked.json"),
      );
      for (const selected of [
        path.join(external, "tsconfig.json"),
        "linked.json",
        path.dirname(project),
        "",
      ])
        await assert.rejects(
          runTypecheckProbe({
            repo,
            project: selected,
            command,
            run: () => {
              throw new Error("unexpected command execution");
            },
          }),
          /typecheck probe project|explicit project/,
        );
      for (const argv of [[], [""], ["typecheck", "invalid\0argument"]])
        await assert.rejects(
          runTypecheckProbe({ repo, project, command: argv }),
          /nonempty command argv/,
        );
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
}, 15_000);

test("direct executable fixture receives literal argv and observes seeded then clean filesystem", async () => {
  await withProject(async ({ repo, project, directory }) => {
    const executable = path.join(repo, "fixture.cjs");
    await writeFile(
      executable,
      `const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== 'literal ; argument') process.exit(3);
const directory = ${JSON.stringify(directory)};
const seed = fs.readdirSync(directory).find(file => file.startsWith('stll-typecheck-probe-'));
if (seed) {
  console.error(path.relative(process.cwd(), path.join(directory, seed)) + '(1,14): error TS2322: Mismatch');
  process.exitCode = 2;
}
`,
    );
    await runTypecheckProbe({
      repo,
      project,
      command: [process.execPath, executable, "literal ; argument"],
    });
    await assert.rejects(
      runTypecheckProbe({
        repo,
        project,
        command: [path.join(repo, "missing-executable")],
      }),
      /ENOENT/,
    );
  });
}, 15_000);

test("explicit seed directories select included project sources and reject paths outside that project", async () => {
  await withProject(async ({ repo, project, directory }) => {
    const source = path.join(directory, "src");
    await mkdir(source);
    try {
      let calls = 0;
      await runTypecheckProbe({
        repo,
        project,
        seedDirectory: "packages/library/src",
        command,
        run: async () => {
          calls++;
          if (calls === 2) {
            expect(await readdir(source)).toEqual([]);
            return { status: 0, output: "" };
          }
          return {
            status: 1,
            output: `${path.relative(repo, path.join(source, await seedIn(source)))}(1,1): error TS2322: Mismatch`,
          };
        },
      });
      expect(calls).toBe(2);
      for (const seedDirectory of [
        ".",
        "packages",
        repo,
        "../outside",
        project,
      ])
        await assert.rejects(
          runTypecheckProbe({ repo, project, seedDirectory, command }),
          /typecheck probe seed directory/,
        );
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });
}, 15_000);

// The built Node entry and real compiler are exercised by repository CI.
test.skipIf(process.env["CI"] !== "true")(
  "built probe CLI checks real Bun diagnostics and supports help without a project",
  async () => {
    const cli = path.resolve(
      import.meta.dir,
      "../dist/typecheck-probe-cli.mjs",
    );
    await withProject(async ({ repo, project, directory }) => {
      const help = spawnSync("node", [cli, "--help"], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(help.error).toBeUndefined();
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("Usage:");
      await writeFile(
        path.join(repo, project),
        JSON.stringify({
          compilerOptions: { noEmit: true, types: [] },
          include: ["*.ts"],
        }),
      );
      const checked = spawnSync(
        "node",
        [cli, "--project", project, "--", "bun", "check", "-p", project],
        { cwd: repo, encoding: "utf8", timeout: 30_000 },
      );
      expect(checked.error).toBeUndefined();
      expect(checked.stderr).toBe("");
      expect(checked.status).toBe(0);
      expect(checked.stdout).toContain("2322");
      expect(
        (await readdir(directory)).filter((file) =>
          file.startsWith("stll-typecheck-probe-"),
        ),
      ).toEqual([]);
    });
  },
);

test("probe containment rejects Windows sibling projects and seed directories", () => {
  const paths = path.win32;
  const root = String.raw`C:\work\repo`;
  const projectDirectory = paths.join(root, "packages", "library");
  expect(
    insideProbePath({
      root,
      candidate: paths.join(root, "tsconfig.json"),
      paths,
    }),
  ).toBe(true);
  expect(
    insideProbePath({
      root,
      candidate: paths.join(root, "..", "sibling", "tsconfig.json"),
      paths,
    }),
  ).toBe(false);
  expect(
    insideProbePath({
      root: projectDirectory,
      candidate: paths.join(projectDirectory, "..", "sibling"),
      paths,
    }),
  ).toBe(false);
  expect(
    insideProbePath({
      root: projectDirectory,
      candidate: paths.join(projectDirectory, "src"),
      paths,
    }),
  ).toBe(true);
  expect(
    insideProbePath({
      root,
      candidate: String.raw`D:\work\repo\tsconfig.json`,
      paths,
    }),
  ).toBe(false);
}, 15_000);

const consumerRepo = path.resolve("/consumer-repo");

test("diagnostic sets canonicalize TypeScript and Bun locations and ignore summaries", () => {
  const tsc = [
    "src/input.ts(4,7): error TS2322: wrong type",
    "src/other.ts(12,1): error TS7006: implicit any",
    "src/input.ts(4,18): error TS2322: repeated on the same line",
  ].join("\n");
  const bun = [
    `${consumerRepo}/src/other.ts(12,1): error TS7006: implicit any`,
    "./src/input.ts(4,7): error TS2322: wrong type",
    "Found 2 errors in 2 files, checked 17 files [24.24ms]",
  ].join("\n");
  const expected = ["src/input.ts:4:2322", "src/other.ts:12:7006"];
  expect(diagnosticSet(tsc, consumerRepo)).toEqual(expected);
  expect(diagnosticSet(bun, consumerRepo)).toEqual(expected);
  expect(
    diagnosticSet(
      "\u001b[31msrc/input.ts:4:7: error TS2322: wrong type\u001b[0m",
      consumerRepo,
    ),
  ).toEqual(["src/input.ts:4:2322"]);
});

test("Bun workspace prefixes preserve diagnostic identity across output formats", () => {
  for (const prefix of [
    "",
    "@stll/library typecheck: ",
    "library typecheck: ",
    "@scope/package-name typecheck:test: ",
    "package.name check_types-2: ",
  ]) {
    for (const diagnostic of [
      "src/input.ts(4,7): error TS2322: wrong type",
      "src/input.ts:4:7: error TS2322: wrong type",
      "src/input.ts:4:7: warning 2322: wrong type",
      "error TS5083: Cannot read configuration file.",
      "warning TS5083: Cannot read configuration file.",
    ]) {
      const expected = diagnosticSet(diagnostic, consumerRepo);
      expect(expected).toHaveLength(1);
      for (const output of [
        `${prefix}${diagnostic}`,
        `\u001b[32m${prefix}\u001b[0m\u001b[31m${diagnostic}\u001b[0m`,
      ])
        expect(diagnosticSet(output, consumerRepo)).toEqual(expected);
    }
  }
});

test("diagnostic paths containing spaces and colons retain their complete location", () => {
  for (const file of [
    "src/package typecheck: input.ts",
    "./package typecheck: input.ts",
    "/workspace/package typecheck: input.ts",
    "src/input file.ts",
    "src/input:version.ts",
  ])
    expect(
      diagnosticSet(`${file}(4,7): error TS2322: wrong type`, consumerRepo),
    ).toEqual([
      `${path.relative(consumerRepo, path.resolve(consumerRepo, file))}:4:2322`,
    ]);
});

test("tagged agent diagnostics retain primary location independent of attribute order", () => {
  expect(
    diagnosticSet(
      '<error file="src/index.ts" line="3" column="25" code="TS2322">\nwrong type\n<source>const x = 1;</source><related file="src/user.ts" line="2" column="3">related</related></error>\n<error code="TS7006" column="1" line="9" file="src/other.ts">implicit any</error>',
      consumerRepo,
    ),
  ).toEqual(["src/index.ts:3:2322", "src/other.ts:9:7006"]);
});

test("configuration and standard library diagnostics keep stable identities", () => {
  expect(
    diagnosticSet(
      "error TS5083: Cannot read configuration file.\nerror TS18003: No inputs were found.\nerror TS18003:   No   inputs were found.  \n",
      consumerRepo,
    ),
  ).toEqual([
    "<config>:0:18003:No inputs were found.",
    "<config>:0:5083:Cannot read configuration file.",
  ]);
  const expected = ["<lib>/lib.es5.d.ts:42:2322"];
  for (const output of [
    `${consumerRepo}/node_modules/typescript/lib/lib.es5.d.ts(42,7): error TS2322: library error`,
    "bundled:///libs/lib.es5.d.ts:42:7: error TS2322: library error",
    '<error file="bundled:///libs/lib.es5.d.ts" line="42" column="7" code="TS2322">library error</error>',
  ])
    expect(diagnosticSet(output, consumerRepo)).toEqual(expected);
});
