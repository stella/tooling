import { expect, test } from "bun:test";

import { lintInventoryCommands } from "./toolchain-lint-command";

const manifest = (scripts: Record<string, string>) => ({
  devDependencies: { "oxlint-tsgolint": "7.0.2003" },
  scripts,
});

test("consumers without the type-aware engine do not enable inventory", () => {
  for (const value of [null, [], {}, { scripts: { lint: "oxlint ." } }]) {
    expect(lintInventoryCommands(value)).toEqual({
      commands: [],
      errors: [],
      enabled: false,
      workspaceTask: false,
    });
  }
  expect(
    lintInventoryCommands({
      dependencies: { "oxlint-tsgolint": "7.0.2003" },
      scripts: { lint: "oxlint ." },
    }).enabled,
  ).toBe(true);
});

test("native package lint scripts retain scope and diagnostic flags without requesting type analysis", () => {
  expect(
    lintInventoryCommands(
      manifest({
        lint: "bun --bun oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error --deny-warnings --type-aware .",
      }),
    ),
  ).toEqual({
    enabled: true,
    workspaceTask: false,
    errors: [],
    commands: [
      [
        "-c",
        "oxlint.config.ts",
        "--report-unused-disable-directives-severity=error",
        "--deny-warnings",
        ".",
      ],
    ],
  });
});

test("literal Turbo lint delegates workspace discovery without executing Turbo", () => {
  expect(lintInventoryCommands(manifest({ lint: "turbo run lint" }))).toEqual({
    enabled: true,
    workspaceTask: true,
    errors: [],
    commands: [],
  });
  expect(
    lintInventoryCommands(
      { scripts: { lint: "oxlint -c ../../oxlint.config.ts ." } },
      true,
    ),
  ).toEqual({
    enabled: true,
    workspaceTask: false,
    errors: [],
    commands: [["-c", "../../oxlint.config.ts", "."]],
  });
});

test("workspace delegation rejects filters, options, prefixes, and dynamic tasks", () => {
  for (const command of [
    "turbo run lint --filter core",
    "turbo --filter=core run lint",
    "turbo run lint build",
    "turbo run lint --",
    "turbo lint",
    "CI=1 turbo run lint",
    "env -C subdir turbo run lint",
    "turbo run $TASK",
  ]) {
    const result = lintInventoryCommands(
      manifest({ lint: `oxlint root.mjs && ${command}` }),
    );
    expect(result.errors.length, command).toBeGreaterThan(0);
    expect(result.workspaceTask, command).toBe(false);
    expect(result.commands, command).toEqual([]);
  }
});

test("workspace lint aliases recurse without executing preparation commands", () => {
  const result = lintInventoryCommands(
    manifest({
      lint: "turbo run lint && bun run lint:oxlint && bun run check:brand-case",
      "lint:oxlint":
        "bun test oxlint.plugin.test.ts && bun run lint:prepare && bun --bun oxlint -c oxlint.config.ts --deny-warnings --type-aware .",
      "lint:prepare":
        "bun x tsdown --config packages/anonymize/tsdown.config.ts --no-clean",
      "check:brand-case": "node -e 'throw new Error(\"must never execute\")'",
    }),
  );
  expect(result).toEqual({
    enabled: true,
    workspaceTask: true,
    errors: [],
    commands: [["-c", "oxlint.config.ts", "--deny-warnings", "."]],
  });
});

test("supported literal launchers preserve ordered file-selection arguments", () => {
  for (const launcher of [
    "oxlint",
    "./node_modules/.bin/oxlint",
    "node_modules/.bin/oxlint",
    "bun --bun oxlint",
    "bunx oxlint",
    "bunx --no-install oxlint",
  ]) {
    expect(
      lintInventoryCommands(
        manifest({
          lint: `${launcher} --ignore-path '.lint ignore' --ignore-pattern '**/generated/**' --no-ignore --disable-nested-config --type-check 'scripts/**/*.mjs'`,
        }),
      ),
    ).toEqual({
      enabled: true,
      workspaceTask: false,
      errors: [],
      commands: [
        [
          "--ignore-path",
          ".lint ignore",
          "--ignore-pattern",
          "**/generated/**",
          "--no-ignore",
          "--disable-nested-config",
          "scripts/**/*.mjs",
        ],
      ],
    });
  }
});

test("shared shell parsing distinguishes executable nested programs from quoted metadata", () => {
  expect(
    lintInventoryCommands(
      manifest({
        lint: "echo oxlint; printf '%s' 'oxlint --fix .'; bash -c 'oxlint -c oxlint.config.ts .'",
      }),
    ),
  ).toEqual({
    enabled: true,
    workspaceTask: false,
    errors: [],
    commands: [["-c", "oxlint.config.ts", "."]],
  });
});

test("unsupported flags, argument expansion, modes, and launchers fail closed", () => {
  for (const command of [
    "oxlint --future-ignore src .",
    "oxlint --config",
    "oxlint --config= .",
    "oxlint --config $CONFIG .",
    'oxlint --config "$CONFIG" .',
    "oxlint --config $(node config-path.js) .",
    "oxlint scripts/*.mjs",
    "oxlint --fix .",
    "oxlint --fix-dangerously .",
    "oxlint --init",
    "oxlint --debug timings .",
    "oxlint --print-config",
    "oxlint --help",
    "oxlint --version",
    "oxlint --rules",
    "oxlint --lsp",
    "oxlint -- .",
    "bun --cwd subdir --bun oxlint .",
    "env -C subdir oxlint .",
    "CONFIG_PATH=config oxlint .",
    "npx oxlint .",
    "bunx oxlint@1.87.0 .",
    "$LINTER .",
  ]) {
    const result = lintInventoryCommands(manifest({ lint: command }));
    expect(result.enabled).toBe(true);
    expect(result.errors.length, command).toBeGreaterThan(0);
    expect(result.commands, command).toEqual([]);
  }
});

test("cwd changes, cyclic aliases, missing scripts, and absent oxlint are diagnosed", () => {
  const cases: Record<string, string>[] = [
    { lint: "cd packages/core && oxlint ." },
    { lint: "bun run cycle", cycle: "bun run lint" },
    { lint: "bun run missing" },
    { lint: "bun run $SCRIPT" },
    { lint: "bun run lint:core -- --fix", "lint:core": "oxlint ." },
    { lint: "turbo run lint --filter core" },
  ];
  for (const scripts of cases) {
    expect(
      lintInventoryCommands(manifest(scripts)).errors.length,
    ).toBeGreaterThan(0);
    expect(lintInventoryCommands(manifest(scripts)).commands).toEqual([]);
  }
  expect(lintInventoryCommands(manifest({})).errors.length).toBeGreaterThan(0);
});

test("unsupported alias launchers cannot silently omit another lint scope", () => {
  for (const alias of [
    "CI=1 bun run lint:core",
    "env -C packages/core bun run lint:core",
    "bun lint:core",
  ]) {
    expect(
      lintInventoryCommands(
        manifest({
          lint: `oxlint root.mjs && ${alias}`,
          "lint:core": "oxlint core.mjs",
        }),
      ).errors.length,
      alias,
    ).toBeGreaterThan(0);
  }
});

test("aliases visited repeatedly do not duplicate inventory commands", () => {
  expect(
    lintInventoryCommands(
      manifest({
        lint: "bun run lint:core && bun run lint:core",
        "lint:core": "oxlint --ignore-pattern='**/dist/**' --threads 1 .",
      }),
    ).commands,
  ).toEqual([["--ignore-pattern=**/dist/**", "--threads", "1", "."]]);
});
