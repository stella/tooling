import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import {
  createTestTmpDir,
  createTestTmpDirSlot,
  withTestTmpDir,
} from "../src/tmp.js";
import { describe, expect, test } from "./runner.js";

describe("test temp dirs", () => {
  test("each directory is fresh and removed when its scope ends", async () => {
    const seen: string[] = [];
    await withTestTmpDir(async (dir) => {
      seen.push(dir.path);
      await writeFile(dir.join("a.txt"), "a");
      expect(await readFile(dir.join("a.txt"), "utf-8")).toBe("a");
    });
    await withTestTmpDir((dir) => {
      seen.push(dir.path);
    });
    expect(new Set(seen).size).toBe(2);
    expect(seen.some((dir) => existsSync(dir))).toBe(false);
  });

  test("the directory is removed when the body throws", async () => {
    let created = "";
    const failing = withTestTmpDir((dir) => {
      created = dir.path;
      throw new Error("body failed");
    });
    await expect(failing).rejects.toThrow("body failed");
    expect(created).not.toBe("");
    expect(existsSync(created)).toBe(false);
  });

  test("join refuses paths that leave the directory", async () => {
    await using dir = await createTestTmpDir();
    expect(dir.join("nested", "file").startsWith(dir.path)).toBe(true);
    expect(() => dir.join("..", "elsewhere")).toThrow("escapes");
    expect(() => dir.join("/etc/passwd")).toThrow("escapes");
  });

  test("refuses a prefix that is not short kebab-case", async () => {
    await expect(createTestTmpDir("../up")).rejects.toThrow("kebab-case");
  });
});

describe("temp dir slot", () => {
  test("an overlapping open is refused and keeps the running test's directory", async () => {
    const slot = createTestTmpDirSlot("kit-slot");
    await slot.open();
    const running = slot.current().path;
    await expect(slot.open()).rejects.toThrow("one test at a time");
    // The refused test's teardown runs first and must leave the directory.
    await slot.close();
    expect(existsSync(running)).toBe(true);
    expect(slot.current().path).toBe(running);
    await slot.close();
    expect(existsSync(running)).toBe(false);
    expect(() => slot.current()).toThrow("only while a test runs");
  });
});
