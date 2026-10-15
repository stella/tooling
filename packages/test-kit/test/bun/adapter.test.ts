import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { useTestTmpDir } from "../../src/bun.js";

describe("bun temp directory lifecycle", () => {
  const tmp = useTestTmpDir("kit-bun");
  const paths: string[] = [];

  afterAll(() => {
    expect(paths.length).toBe(2);
    expect(new Set(paths).size).toBe(2);
    expect(paths.every((path) => !existsSync(path))).toBe(true);
    expect(() => tmp()).toThrow("only while a test runs");
  });

  test("the first test receives a writable directory", async () => {
    paths.push(tmp().path);
    await writeFile(tmp().join("left-over"), "x");
  });

  test("the next test receives a fresh directory after cleanup", () => {
    for (const path of paths) {
      expect(existsSync(path)).toBe(false);
      expect(tmp().path).not.toBe(path);
    }
    paths.push(tmp().path);
    expect(existsSync(tmp().join("left-over"))).toBe(false);
  });
});
