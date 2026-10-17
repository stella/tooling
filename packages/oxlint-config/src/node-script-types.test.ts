/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const configDirectory = path.resolve(
  import.meta.dir,
  "../../typescript-config",
);
const oxlintDirectory = path.dirname(require.resolve("oxlint/package.json"));
const backendDirectory = path.dirname(
  require.resolve("oxlint-tsgolint/package.json"),
);
const bunTypesDirectory = path.dirname(
  require.resolve("bun-types/package.json"),
);
const nodeTypesDirectory = realpathSync(
  path.dirname(
    createRequire(path.join(bunTypesDirectory, "package.json")).resolve(
      "@types/node/package.json",
    ),
  ),
);

const imports = {
  js: 'import { existsSync } from "node:fs";\nimport { open } from "node:fs/promises";\n',
  mjs: 'import { existsSync } from "node:fs";\nimport { open } from "node:fs/promises";\n',
  cjs: 'const fs = require("node:fs");\nconst fsPromises = require("node:fs/promises");\n',
};

const fixtureSource = (extension: keyof typeof imports) => {
  const source = `${imports[extension]}
const present = ${extension === "cjs" ? "fs.existsSync" : "existsSync"}(".");
const description = present ? "present" : "missing";
const regularFile = async () => {
  const file = await ${extension === "cjs" ? "fsPromises.open" : "open"}("fixture.txt", "r");
  try {
    const stats = await file.stat();
    return stats.isFile() ? "regular" : "other";
  } finally {
    await file.close();
  }
};
`;
  return (
    source +
    (extension === "cjs"
      ? "exports.description = description;\nexports.regularFile = regularFile;\n"
      : "export { description, regularFile };\n")
  );
};

// Invoke only the named fixture: this regression never scans a consumer tree.
const lintFixture = (root: string, source: string) => {
  const result = spawnSync(
    process.execPath,
    [
      "--bun",
      path.join(oxlintDirectory, "bin/oxlint"),
      "--config",
      path.join(root, ".oxlintrc.json"),
      "--type-aware",
      "--type-check",
      source,
    ],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  if (result.error !== undefined) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
};

test.each(["js", "mjs", "cjs"] as const)(
  "the shared Node preset supplies real Node types for owned .%s scripts",
  (extension) => {
    const root = mkdtempSync(path.join(tmpdir(), "stll-node-scripts-"));
    try {
      mkdirSync(path.join(root, "scripts"));
      mkdirSync(path.join(root, "node_modules/@types"), { recursive: true });
      mkdirSync(path.join(root, "node_modules/@stll"), { recursive: true });
      mkdirSync(path.join(root, "node_modules/.bin"));
      symlinkSync(
        backendDirectory,
        path.join(root, "node_modules/oxlint-tsgolint"),
        "dir",
      );
      // Oxlint discovers the backend through the consumer's node_modules/.bin.
      symlinkSync(
        path.join(backendDirectory, "bin/tsgolint.js"),
        path.join(root, "node_modules/.bin/tsgolint"),
      );
      // Model an isolated consumer's direct dependency, not a hoisted root @types tree.
      symlinkSync(
        nodeTypesDirectory,
        path.join(root, "node_modules/@types/node"),
        "dir",
      );
      symlinkSync(
        configDirectory,
        path.join(root, "node_modules/@stll/typescript-config"),
        "dir",
      );
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        path.join(root, ".oxlintrc.json"),
        JSON.stringify({
          plugins: ["typescript"],
          rules: { "typescript/strict-boolean-expressions": "error" },
        }),
      );
      const project = path.join(root, "scripts/tsconfig.json");
      const writeProject = (preset: "library" | "node") =>
        writeFileSync(
          project,
          JSON.stringify({
            extends: `@stll/typescript-config/${preset}.json`,
            include: ["**/*.js", "**/*.mjs", "**/*.cjs"],
          }),
        );
      const source = path.join(root, `scripts/fixture.${extension}`);
      writeFileSync(source, fixtureSource(extension));
      const inferred = lintFixture(root, source);
      expect(inferred.status, inferred.output).not.toBe(0);
      expect(inferred.output).toContain("Unexpected any");

      writeProject("library");
      const missingAmbient = lintFixture(root, source);
      expect(missingAmbient.status, missingAmbient.output).not.toBe(0);
      expect(missingAmbient.output).toContain("TS2591");
      expect(missingAmbient.output).toContain("node:fs");

      writeProject("node");
      const typed = lintFixture(root, source);
      expect(typed.status, typed.output).toBe(0);
      expect(typed.output).not.toContain("TS2591");
      expect(typed.output).not.toContain("Unexpected any");

      writeFileSync(
        source,
        fixtureSource(extension) +
          '/** @type {boolean} */\nconst wrongType = "not-a-boolean";\n' +
          (extension === "cjs"
            ? "exports.wrongType = wrongType;\n"
            : "export { wrongType };\n"),
      );
      const realTypeError = lintFixture(root, source);
      expect(realTypeError.status, realTypeError.output).not.toBe(0);
      expect(realTypeError.output).toContain("TS2322");
      expect(realTypeError.output).not.toContain("TS2591");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
