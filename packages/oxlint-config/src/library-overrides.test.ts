/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  library,
  libraryOverrides,
  libraryRules,
  unsafeAnyOverrides,
  unsafeAnyRules,
} from "./index";

const oxlintBin = fileURLToPath(
  new URL("./bin/oxlint", import.meta.resolve("oxlint/package.json")),
);

test("test and CommonJS overrides reach nested folders and every module extension", async () => {
  const directory = await mkdtemp(join(tmpdir(), "library-overrides-"));
  try {
    const size = "export const size = (value?: string) => value!.length;\n";
    const required =
      'const path = require("node:path");\n\nmodule.exports = path;\n';
    const files = {
      "packages/core/src/size.ts": size,
      "packages/core/__tests__/size.ts": size,
      "packages/core/__test__/size.ts": size,
      "packages/core/src/size.test.mts": size,
      "packages/core/src/size.spec.cts": size,
      "packages/core/src/load.js": required,
      "packages/core/scripts/load.cjs": required,
    };
    for (const [file, source] of Object.entries(files)) {
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
    expect(flagged).toHaveLength(2);
    expect(flagged).toEqual(
      expect.arrayContaining([
        "typescript(no-non-null-assertion) packages/core/src/size.ts",
        "typescript(no-require-imports) packages/core/src/load.js",
      ]),
    );
    expect(exitCode).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("unsafe any rules are on, relaxed for test matchers and off in JavaScript, only through their own overrides", () => {
  expect(libraryRules).toEqual(expect.objectContaining(unsafeAnyRules));
  const [tests, javascript] = unsafeAnyOverrides;
  expect(tests?.files).toEqual(libraryOverrides[0]?.files);
  expect(tests?.rules).toEqual(
    expect.objectContaining({
      "typescript/no-unsafe-argument": "off",
      "typescript/no-unsafe-assignment": "off",
    }),
  );
  expect(tests?.rules).not.toHaveProperty(["typescript/no-unsafe-call"]);
  // Configs that spread `libraryOverrides` over a preset with its own
  // any-flow scope must not have those rules relaxed.
  expect(
    libraryOverrides.flatMap((override) => Object.keys(override.rules)),
  ).not.toEqual(expect.arrayContaining(Object.keys(unsafeAnyRules)));
  expect(javascript?.files).toEqual(["**/*.{js,jsx,mjs,cjs}"]);
  expect(javascript?.rules).toEqual(
    Object.fromEntries(
      Object.keys(unsafeAnyRules).map((rule) => [rule, "off"]),
    ),
  );
});
