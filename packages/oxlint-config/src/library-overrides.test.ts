/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { library } from "./index";

const oxlintBin = fileURLToPath(
  new URL("./bin/oxlint", import.meta.resolve("oxlint/package.json")),
);

test("test overrides reach nested test folders and every module extension", async () => {
  const directory = await mkdtemp(join(tmpdir(), "library-overrides-"));
  try {
    const source = "export const size = (value?: string) => value!.length;\n";
    const files = [
      "packages/core/src/size.ts",
      "packages/core/__tests__/size.ts",
      "packages/core/__test__/size.ts",
      "packages/core/src/size.test.mts",
      "packages/core/src/size.spec.cts",
    ];
    for (const file of files) {
      await mkdir(join(directory, file, ".."), { recursive: true });
      await writeFile(join(directory, file), source);
    }
    const config = library({
      options: { typeAware: false, denyWarnings: false },
    });
    config.jsPlugins = [];
    const rules = { ...config.rules };
    delete rules["stella-lowercase/stella-lowercase"];
    delete rules["no-raw-colors/no-raw-colors"];
    config.rules = rules;
    await writeFile(join(directory, "oxlint.json"), JSON.stringify(config));

    const lint = Bun.spawn(
      [oxlintBin, "-c", "oxlint.json", "--format", "json", "."],
      { cwd: directory, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(lint.stdout).text(),
      lint.exited,
    ]);
    const result: unknown = JSON.parse(stdout);
    if (
      typeof result !== "object" ||
      result === null ||
      !("diagnostics" in result) ||
      !Array.isArray(result.diagnostics)
    )
      throw new Error(`Unexpected oxlint output: ${stdout}`);
    const flagged: unknown[] = result.diagnostics.map((diagnostic: unknown) =>
      typeof diagnostic === "object" &&
      diagnostic !== null &&
      "code" in diagnostic &&
      "filename" in diagnostic
        ? `${String(diagnostic.code)} ${String(diagnostic.filename)}`
        : diagnostic,
    );
    expect(flagged).toEqual([
      "typescript(no-non-null-assertion) packages/core/src/size.ts",
    ]);
    expect(exitCode).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
