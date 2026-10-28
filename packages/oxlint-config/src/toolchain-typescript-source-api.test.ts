import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readSourceApiInput } from "./toolchain-typescript-source-api";

test("source API evidence rejects untracked files and every symlink boundary", () => {
  const root = mkdtempSync(path.join(tmpdir(), "source-api-input-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(
      path.join(root, "scripts/source.ts"),
      'import ts from "typescript";',
    );
    symlinkSync("source.ts", path.join(root, "scripts/alias.ts"));
    symlinkSync("scripts", path.join(root, "alias"));
    const tracked = new Set([
      "scripts/source.ts",
      "scripts/alias.ts",
      "alias/source.ts",
      "scripts/missing.ts",
    ]);
    expect(
      readSourceApiInput({ root, source: "scripts/source.ts", tracked }),
    ).toContain("typescript");
    expect(
      readSourceApiInput({
        root,
        source: "scripts/source.ts",
        tracked: new Set(),
      }),
    ).toBeUndefined();
    for (const source of [
      "scripts/alias.ts",
      "alias/source.ts",
      "scripts/missing.ts",
    ])
      expect(readSourceApiInput({ root, source, tracked })).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
