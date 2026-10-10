import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  artifactEcmaVersion,
  assertPackedArtifactSyntax,
  checkPackedJavaScriptWithNode,
  readPackedSyntaxFiles,
} from "./publish-artifact-syntax";
import type { PublishTarget } from "./publish-contract";

const target = {
  type: "javascript",
  targets: ["es2022"],
} as const satisfies PublishTarget;
const node = "22.23.3";
const files = (
  entries: Record<string, string>,
  type: "module" | "commonjs" = "module",
) =>
  new Map([
    [
      "package/package.json",
      JSON.stringify({ name: "syntax-fixture", version: "1.0.0", type }),
    ],
    ...Object.entries(entries).map(
      ([file, source]) => [`package/${file}`, source] as const,
    ),
  ]);

test("declared target mappings form a closed grammar and combine at the strictest bound", () => {
  for (const year of [
    2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025,
  ] as const)
    expect(
      artifactEcmaVersion({
        target: { type: "javascript", targets: [`es${year}`] },
        node,
      }),
    ).toBe(year);
  expect(
    artifactEcmaVersion({
      target: { type: "javascript", targets: ["esnext", "es2022", "es2020"] },
      node,
    }),
  ).toBe(2020);
  for (const value of [
    "esnext",
    "node20",
    "node20.19.0",
    "node22.0",
    "node22",
    `node${node}`,
  ])
    expect(
      artifactEcmaVersion({
        target: { type: "javascript", targets: [value] },
        node,
      }),
    ).toBe("latest");
  for (const value of [
    "eslatest",
    "es2026",
    `node${Number(node.split(".").at(0)) + 1}`,
    "chrome130",
    "es2022,node26",
  ])
    expect(() =>
      artifactEcmaVersion({
        target: { type: "javascript", targets: [value] },
        node,
      }),
    ).toThrow("Unsupported");
  expect(() =>
    artifactEcmaVersion({ target: { type: "javascript", targets: [] }, node }),
  ).toThrow("declared target");
});

test("every JavaScript extension and non-entry chunk obeys the declared syntax bound", () => {
  for (const name of ["index.js", "chunks/non-entry.mjs", "bin/tool.cjs"])
    expect(() =>
      assertPackedArtifactSyntax({
        files: files({ [name]: "const value = input?.field;" }),
        target: { type: "javascript", targets: ["es2019"] },
        node,
      }),
    ).toThrow(name);
  expect(() =>
    assertPackedArtifactSyntax({
      files: files({
        "index.mjs": "export const value = input?.field;",
        "bin/tool.cjs":
          "#!/usr/bin/env node\nmodule.exports = class { static { this.value = 1; } };",
      }),
      target,
      node,
    }),
  ).not.toThrow();
  expect(() =>
    assertPackedArtifactSyntax({
      files: files({ "index.mjs": "export const pattern = /x/v;" }),
      target,
      node,
    }),
  ).toThrow("declared syntax target");
});

test("types-only artifacts cannot hide JavaScript in bins or chunks", () => {
  for (const name of ["index.js", "bin/tool.cjs", "chunks/extra.mjs"])
    expect(() =>
      assertPackedArtifactSyntax({
        files: files({ [name]: "" }),
        target: { type: "types-only" },
        node,
      }),
    ).toThrow("Types-only");
  expect(() =>
    assertPackedArtifactSyntax({
      files: files({ "index.d.ts": "export {};" }),
      target: { type: "types-only" },
      node,
    }),
  ).not.toThrow();
});

test("nested manifests and explicit extensions determine module grammar", () => {
  const content = files(
    {
      "index.js": "module.exports = 1;",
      "nested/package.json": JSON.stringify({ type: "module" }),
      "nested/chunk.js": "export const value = 1;",
      "bin/command.cjs": "return;",
      "esm.mjs": "export {};",
    },
    "commonjs",
  );
  expect(() =>
    assertPackedArtifactSyntax({ files: content, target, node }),
  ).not.toThrow();
  content.set("package/index.js", "export {};");
  expect(() =>
    assertPackedArtifactSyntax({ files: content, target, node }),
  ).toThrow("index.js");
  expect(() =>
    assertPackedArtifactSyntax({
      files: files({ "index.mjs": "export {};" }),
      target: { type: "javascript", targets: ["es5"] },
      node,
    }),
  ).toThrow("ES5");
});

test("unbounded targets still pass through native Node parsing without executing artifact code", async () => {
  const executable = execFileSync("node", ["-p", "process.execPath"], {
    encoding: "utf8",
  }).trim();
  const version = execFileSync(executable, ["--version"], { encoding: "utf8" })
    .trim()
    .slice(1);
  const content = files({
    "index.mjs": "throw new Error('must not execute'); export {};",
    "bin/tool.cjs": "#!/usr/bin/env node\nreturn;",
  });
  await checkPackedJavaScriptWithNode({
    files: content,
    target: { type: "javascript", targets: ["esnext"] },
    node: version,
    executable,
  });
  content.set("package/index.mjs", "await = 1;");
  await assert.rejects(
    checkPackedJavaScriptWithNode({
      files: content,
      target,
      node: version,
      executable,
    }),
    /index.mjs/,
  );
});

test("tarball inspection checks non-entry JavaScript and rejects linked syntax inputs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "artifact-syntax-tar-"));
  try {
    await mkdir(path.join(root, "package/chunks"), { recursive: true });
    await writeFile(
      path.join(root, "package/package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(path.join(root, "package/index.js"), "export {};\n");
    await writeFile(
      path.join(root, "package/chunks/extra.mjs"),
      "export const newer = input?.value;\n",
    );
    const archive = path.join(root, "artifact.tgz");
    execFileSync("tar", ["-czf", archive, "package"], { cwd: root });
    const packed = await readPackedSyntaxFiles(archive);
    expect([...packed.keys()].sort()).toEqual([
      "package/chunks/extra.mjs",
      "package/index.js",
      "package/package.json",
    ]);
    expect(() =>
      assertPackedArtifactSyntax({
        files: packed,
        target: { type: "javascript", targets: ["es2019"] },
        node,
      }),
    ).toThrow("extra.mjs");
    await symlink("index.js", path.join(root, "package/linked.js"));
    execFileSync("tar", ["-czf", archive, "package"], { cwd: root });
    await assert.rejects(readPackedSyntaxFiles(archive), /regular file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native syntax staging rejects paths outside the packed tree", async () => {
  await assert.rejects(
    checkPackedJavaScriptWithNode({
      files: new Map([["../escape.js", ""]]),
      target,
      node,
      executable: "node",
    }),
    /artifact member/,
  );
});

test("declared extensionless Node executables obey the syntax bound", () => {
  const content = files({
    "bin/command": "#!/usr/bin/env node\nconst newer = input?.field;",
  });
  content.set(
    "package/package.json",
    JSON.stringify({ bin: { command: "./bin/command" } }),
  );
  expect(() =>
    assertPackedArtifactSyntax({
      files: content,
      target: { type: "javascript", targets: ["es2019"] },
      node,
    }),
  ).toThrow("bin/command");
  content.set("package/bin/command", "#!/bin/sh\necho ok");
  expect(() =>
    assertPackedArtifactSyntax({ files: content, target, node }),
  ).toThrow("Unsupported packed executable language");
});
