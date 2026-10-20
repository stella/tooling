import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readPackedSyntaxFiles } from "./publish-artifact-syntax";

type PackedFixture = {
  root: string;
  archive: string;
  repack: () => void;
};
const withPackedFixture = async (
  entries: Record<string, string | Uint8Array>,
  exercise: (fixture: PackedFixture) => Promise<void>,
) => {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-import-archive-"));
  try {
    for (const [file, source] of Object.entries(entries)) {
      const destination = path.join(root, "package", file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, source);
    }
    const archive = path.join(root, "artifact.tgz");
    const repack = () => {
      execFileSync("tar", ["-czf", archive, "package"], { cwd: root });
    };
    repack();
    await exercise({ root, archive, repack });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("packed bins and exports require their transitive externalized helper", async () => {
  await withPackedFixture(
    {
      "package.json": JSON.stringify({
        type: "module",
        exports: { ".": "./dist/native-node.mjs" },
        bin: { build: "./scripts/build-native-pipeline-package.mjs" },
      }),
      "scripts/build-native-pipeline-package.mjs":
        'import { detect } from "../dist/native-node.mjs"; console.log(detect());',
      "dist/native-node.mjs":
        'export { detectNativeLibc as detect } from "../native-libc.mjs";',
    },
    async ({ root, archive, repack }) => {
      await assert.rejects(readPackedSyntaxFiles(archive), /native-libc\.mjs/);
      await writeFile(
        path.join(root, "package/native-libc.mjs"),
        'export const detectNativeLibc = () => "gnu";',
      );
      repack();
      const packed = await readPackedSyntaxFiles(archive);
      expect(packed.has("package/native-libc.mjs")).toBe(true);
      expect(
        packed.has("package/scripts/build-native-pipeline-package.mjs"),
      ).toBe(true);
    },
  );
}, 15_000);

test("opaque native members are validated without decoding or caching their bytes", async () => {
  await withPackedFixture(
    {
      "package.json": JSON.stringify({ main: "./index.cjs" }),
      "index.cjs": 'module.exports = require("./binding.node");',
      "binding.node": new Uint8Array([0, 255, 254, 128, 0]),
    },
    async ({ archive }) => {
      const packed = await readPackedSyntaxFiles(archive);
      expect(packed.has("package/index.cjs")).toBe(true);
      expect(packed.has("package/binding.node")).toBe(false);
    },
  );
}, 15_000);

test("a packed native dependency must be regular even when its link target is packed", async () => {
  await withPackedFixture(
    {
      "package.json": JSON.stringify({ main: "./index.cjs" }),
      "index.cjs": 'module.exports = require("./binding.node");',
      "actual.node": new Uint8Array([0, 255, 0]),
    },
    async ({ root, archive, repack }) => {
      await symlink("actual.node", path.join(root, "package/binding.node"));
      repack();
      await assert.rejects(readPackedSyntaxFiles(archive), /regular file/);
    },
  );
}, 15_000);

test("literal extensionless CommonJS helpers are loaded lazily from the full archive index", async () => {
  await withPackedFixture(
    {
      "package.json": JSON.stringify({ main: "./index.cjs" }),
      "index.cjs": 'module.exports = require("./helper");',
      helper: 'module.exports = "packed helper";',
    },
    async ({ archive }) => {
      const packed = await readPackedSyntaxFiles(archive);
      expect(packed.get("package/helper")).toBe(
        'module.exports = "packed helper";',
      );
    },
  );
}, 15_000);

test("wildcard exported archive patterns leave licenses and directories opaque but follow extensionless imports", async () => {
  await withPackedFixture(
    {
      "package.json": JSON.stringify({
        type: "module",
        exports: { "./*": "./*" },
      }),
      LICENSE: "Copyright reserved. This license text is not JavaScript.",
      "docs/NOTICE": "Documentation is not a runtime module.",
      "entry.mjs": 'import "./helper";',
      helper: 'export { value } from "./nested/leaf.mjs";',
      "nested/leaf.mjs": "export const value = 1;",
    },
    async ({ root, archive, repack }) => {
      const listing = execFileSync("tar", ["-tzf", archive], {
        encoding: "utf8",
      });
      expect(listing).toContain("package/docs/");
      expect(listing).toContain("package/nested/");
      const packed = await readPackedSyntaxFiles(archive);
      expect(packed.has("package/LICENSE")).toBe(false);
      expect(packed.has("package/docs/NOTICE")).toBe(false);
      expect(packed.has("package/docs/")).toBe(false);
      expect(packed.get("package/helper")).toContain("./nested/leaf.mjs");
      await rm(path.join(root, "package/nested/leaf.mjs"));
      repack();
      await assert.rejects(readPackedSyntaxFiles(archive), /leaf\.mjs/);
    },
  );
}, 15_000);

test("malformed packed JavaScript retains its import parser cause and member path", async () => {
  await withPackedFixture(
    {
      "package.json": JSON.stringify({ type: "module" }),
      "dist/chunks/hidden.mjs": "export const syntax = ;\n",
    },
    async ({ archive }) => {
      await assert.rejects(
        readPackedSyntaxFiles(archive),
        (error: unknown) =>
          error instanceof SyntaxError &&
          /Packed runtime import syntax package\/dist\/chunks\/hidden\.mjs:/.test(
            error.message,
          ) &&
          error.cause instanceof SyntaxError,
      );
    },
  );
}, 15_000);
