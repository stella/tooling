import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertConsumerInstalledToolBins,
  consumerReservedToolBins,
} from "./consumer-installed-bins";

test("every reserved tool is rejected across root, npm nested and pnpm virtual-store bins", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "consumer-nested-bins-"));
  try {
    for (const relative of [
      "node_modules/.bin",
      "node_modules/outer/node_modules/.bin",
      "node_modules/.pnpm/inner@1.0.0/node_modules/.bin",
      "node_modules/@scope/outer/node_modules/inner/node_modules/.bin",
    ]) {
      const bin = path.join(directory, relative);
      await mkdir(bin, { recursive: true });
      for (const name of consumerReservedToolBins) {
        const file = path.join(bin, name);
        await writeFile(file, "#!/bin/sh\nexit 0\n");
        await assert.rejects(
          assertConsumerInstalledToolBins(directory),
          new RegExp(`installed consumer binary ${name} conflicts`, "u"),
        );
        await rm(file);
      }
    }
    await assertConsumerInstalledToolBins(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("contained directory aliases and cycles are scanned without following outside targets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "consumer-bin-links-"));
  const outside = await mkdtemp(path.join(tmpdir(), "consumer-bin-outside-"));
  try {
    const packageRoot = path.join(directory, "packages/inner");
    const bin = path.join(packageRoot, "node_modules/.bin");
    await mkdir(bin, { recursive: true });
    await mkdir(path.join(directory, "node_modules"));
    await symlink(packageRoot, path.join(directory, "node_modules/inner"));
    await symlink(packageRoot, path.join(packageRoot, "self"));
    await assertConsumerInstalledToolBins(directory);
    await symlink("missing-node", path.join(bin, "node"));
    await assert.rejects(
      assertConsumerInstalledToolBins(directory),
      /installed consumer binary node conflicts/,
    );
    await rm(path.join(bin, "node"));
    await symlink(outside, path.join(directory, "node_modules/external"));
    await assert.rejects(
      assertConsumerInstalledToolBins(directory),
      /dependency path must stay within the fixture/,
    );
    await assertConsumerInstalledToolBins(outside);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
