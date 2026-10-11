/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  library,
  libraryPlugins,
  libraryRules,
  reactCompilerRules,
  reactRules,
  type LibraryOptions,
} from "./index";

describe("React Compiler rules", () => {
  test("uses actionable category rules instead of the removed monolith", () => {
    expect("react/react-compiler" in libraryRules).toBe(false);
    expect(reactCompilerRules["react/invariant"]).toBe("off");
    expect(reactCompilerRules["react/todo"]).toBe("off");
    expect(reactRules).toEqual(expect.objectContaining(reactCompilerRules));

    const severities = Object.values(reactCompilerRules);
    expect(severities.filter((severity) => severity === "error")).toHaveLength(
      20,
    );
    expect(severities.filter((severity) => severity === "off")).toHaveLength(2);
  });
});

test("the base preset contains no React rules or plugin", () => {
  expect(libraryPlugins).not.toContain("react");
  expect(
    Object.keys(libraryRules).some((name) => name.startsWith("react/")),
  ).toBe(false);
});

test("React diagnostics stay inside consumer-selected files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "react-preset-"));
  try {
    for (const name of ["vue-composable", "react-hook"]) {
      await writeFile(
        join(directory, `${name}.ts`),
        await readFile(
          new URL(`../fixtures/${name}.fixture.ts`, import.meta.url),
        ),
      );
    }
    const lint = async (options: LibraryOptions = {}) => {
      const config = library({
        ...options,
        options: { typeAware: false, denyWarnings: false },
      });
      // Exercise built-in rules without loading unrelated shared JS plugins.
      config.jsPlugins = [];
      const rules = { ...config.rules };
      delete rules["stella-lowercase/stella-lowercase"];
      delete rules["no-raw-colors/no-raw-colors"];
      config.rules = rules;
      await writeFile(join(directory, "oxlint.json"), JSON.stringify(config));
      const process = Bun.spawn(
        [
          fileURLToPath(
            new URL("./bin/oxlint", import.meta.resolve("oxlint/package.json")),
          ),
          "-c",
          "oxlint.json",
          "--format",
          "json",
          ".",
        ],
        { cwd: directory, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      expect(stderr).toBe("");
      const result: unknown = JSON.parse(stdout);
      if (
        typeof result !== "object" ||
        result === null ||
        !("diagnostics" in result) ||
        !Array.isArray(result.diagnostics)
      ) {
        throw new Error(`Unexpected oxlint output: ${stdout}`);
      }
      const diagnostics: unknown[] = result.diagnostics;
      expect(exitCode).toBe(diagnostics.length === 0 ? 0 : 1);
      return diagnostics;
    };
    expect(await lint()).toEqual([]);
    const scoped = await lint({ react: { files: ["react-hook.ts"] } });
    expect(scoped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "react(hooks)",
          filename: "react-hook.ts",
        }),
      ]),
    );
    expect(
      scoped.every(
        (diagnostic) =>
          typeof diagnostic === "object" &&
          diagnostic !== null &&
          "filename" in diagnostic &&
          diagnostic.filename === "react-hook.ts",
      ),
    ).toBe(true);
    // The Vue fixture must trigger the detector when mistakenly selected.
    const allFiles = await lint({ react: { files: ["*.ts"] } });
    expect(allFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "react(hooks)",
          filename: "vue-composable.ts",
        }),
      ]),
    );
    expect(
      await lint({
        react: { files: ["react-hook.ts"] },
        rules: { "react/hooks": "off" },
      }),
    ).toEqual([]);
    expect(
      await lint({
        react: { files: ["react-hook.ts"] },
        rules: { "react/hooks": "off" },
        overrides: [
          { files: ["react-hook.ts"], rules: { "react/hooks": "error" } },
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "react(hooks)",
          filename: "react-hook.ts",
        }),
      ]),
    );
    await writeFile(
      join(directory, "consumer.test.ts"),
      "console.log('consumer');\n",
    );
    expect(
      await lint({
        react: { files: ["react-hook.ts"] },
        rules: { "react/hooks": "off", "no-console": "error" },
      }),
    ).toEqual([
      expect.objectContaining({
        code: "eslint(no-console)",
        filename: "consumer.test.ts",
      }),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("React scoping retains consumer plugins and permits later rule overrides", () => {
  const config = library({
    plugins: ["jsx-a11y"],
    react: { files: ["react/**"] },
    overrides: [{ files: ["react/**"], rules: { "react/hooks": "warn" } }],
  });
  expect(config.overrides?.at(-2)?.plugins).toEqual([
    ...(config.plugins ?? []),
    "react",
  ]);
  expect(config.overrides?.at(-1)?.rules).toEqual({ "react/hooks": "warn" });
});

test("consumer rules win over every preset override", () => {
  const rules = {
    "react/hooks": "off",
    "no-console": "error",
    "no-shadow": "off",
  } as const;
  for (const config of [
    library({ rules }),
    library({ rules, react: { files: ["react/**"] } }),
  ]) {
    expect(config.overrides?.length).toBeGreaterThan(0);
    for (const override of config.overrides ?? []) {
      expect(override.rules).toEqual(expect.objectContaining(rules));
    }
  }
});

test("consumer plugin lists remain authoritative when overriding scoped rules", () => {
  const config = library({
    react: { files: ["react/**"] },
    overrides: [
      {
        files: ["react/**"],
        plugins: ["eslint"],
        rules: { "react/hooks": "off" },
      },
    ],
  });
  expect(config.overrides?.at(-1)?.plugins).toEqual(["eslint"]);
});
