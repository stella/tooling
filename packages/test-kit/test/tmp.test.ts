import { existsSync } from "node:fs";
import fs, { readFile, writeFile } from "node:fs/promises";

import {
  createTestTmpDir,
  createTestTmpDirSlot,
  withTestTmpDir,
} from "../src/tmp.js";
import { rejectionOf } from "./rejection.js";
import { describe, expect, spyOn, test } from "./runner.js";

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
    expect(await rejectionOf(failing)).toMatchObject({
      message: "body failed",
    });
    expect(created).not.toBe("");
    expect(existsSync(created)).toBe(false);
  });

  test("join refuses paths that leave the directory", async () => {
    await using dir = await createTestTmpDir();
    expect(dir.join("nested", "file").startsWith(dir.path)).toBe(true);
    expect(() => dir.join("..", "elsewhere")).toThrow("escapes");
    expect(() => dir.join("/etc/passwd")).toThrow("escapes");
  });

  test("failed removal can be retried and concurrent calls share cleanup", async () => {
    const dir = await createTestTmpDir();
    const failure = new Error("cleanup refused");
    const remove = spyOn(fs, "rm").mockRejectedValueOnce(failure);
    try {
      expect(await rejectionOf(dir.remove())).toBe(failure);
      expect(existsSync(dir.path)).toBe(true);
      const first = dir.remove();
      const concurrent = dir.remove();
      expect(concurrent).toBe(first);
      await Promise.all([first, concurrent]);
      expect(existsSync(dir.path)).toBe(false);
      await dir.remove();
      expect(remove).toHaveBeenCalledTimes(2);
    } finally {
      remove.mockRestore();
      await dir.remove();
    }
  });

  test("refuses a prefix that is not short kebab-case", async () => {
    expect(await rejectionOf(createTestTmpDir("../up"))).toMatchObject({
      message: expect.stringContaining("kebab-case"),
    });
  });
});

describe("temp dir slot", () => {
  test("retains a directory whose cleanup failed until close is retried", async () => {
    const slot = createTestTmpDirSlot("kit-slot");
    await slot.open();
    const running = slot.current().path;
    const failure = new Error("cleanup refused");
    const remove = spyOn(fs, "rm").mockRejectedValueOnce(failure);
    try {
      expect(await rejectionOf(slot.close())).toBe(failure);
      expect(slot.current().path).toBe(running);
      expect(existsSync(running)).toBe(true);
      await slot.close();
      expect(existsSync(running)).toBe(false);
    } finally {
      remove.mockRestore();
      await slot.close();
    }
  });

  test("an overlapping open is refused and keeps the running test's directory", async () => {
    const slot = createTestTmpDirSlot("kit-slot");
    await slot.open();
    const running = slot.current().path;
    try {
      expect(await rejectionOf(slot.open())).toMatchObject({
        message: expect.stringContaining("one test at a time"),
      });
      // The refused test's teardown runs first and must leave the directory.
      await slot.close();
      expect(existsSync(running)).toBe(true);
      expect(slot.current().path).toBe(running);
      await slot.close();
      expect(existsSync(running)).toBe(false);
      expect(() => slot.current()).toThrow("only while a test runs");
    } finally {
      // Also drain a refused open if an earlier assertion interrupted teardown.
      await slot.close();
      await slot.close();
    }
  });
});
