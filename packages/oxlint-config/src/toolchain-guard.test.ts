/// <reference types="bun-types" />
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import toolchain from "../toolchain.json";
import { cloudSetupPath, generateCloudSetup } from "./cloud-setup";
import type { parseCloudSetup } from "./cloud-setup-schema";
import {
  checkToolchain,
  parseToolchainConfiguration,
  toolchainRules,
} from "./toolchain-guard";
import { toolchainInputKind } from "./toolchain-inputs";
import { packagePinKeys, parseToolchainPolicy } from "./toolchain-schema";

const policy = parseToolchainPolicy(toolchain);
const fixture = (
  files: Record<string, string>,
  untracked: Record<string, string> = {},
) => {
  const root = mkdtempSync(path.join(tmpdir(), "stll-shared-toolchain-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const write = (entries: Record<string, string>) => {
      for (const [file, text] of Object.entries(entries)) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), text);
      }
    };
    write(files);
    execFileSync("git", ["add", "-f", "."], { cwd: root });
    write(untracked);
    return checkToolchain({ root, policy });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("empty repositories do not acquire unrelated tool requirements", () => {
  expect(fixture({ "readme.txt": "hello" })).toEqual([]);
});

test("tracked root and nested action metadata cannot bypass snapshot discovery", () => {
  const config = JSON.stringify({
    optOuts: [{ rule: "dependabot-policy", reason: "Action metadata fixture" }],
  });
  for (const file of [
    "action.yml",
    "action.yaml",
    "tools/build/action.yml",
    "tools/deep/build/action.yaml",
    "vendor/build/action.yml",
    "node_modules/build/action.yaml",
  ]) {
    expect(
      fixture({
        [file]:
          "runs: {using: composite, steps: [{uses: 'actions/checkout@main'}]}",
        "stll-toolchain.json": config,
      }).some(
        ({ rule, path: source }) => rule === "action-pins" && source === file,
      ),
    ).toBe(true);
    expect(
      fixture(
        { "stll-toolchain.json": config },
        {
          [file]:
            "runs: {using: composite, steps: [{uses: 'actions/checkout@main'}]}",
        },
      ),
    ).toEqual([]);
  }
});

test("mise environment overrides remain part of the tracked configuration snapshot", () => {
  for (const file of [
    "mise.ci.toml",
    ".mise.production.toml",
    "tools/mise.ci.local.toml",
    ".config/mise/config.ci.toml",
    "mise/conf.d/node.toml",
  ])
    expect(
      fixture({ [file]: "[tools]\nnode = 'latest'" }).some(
        ({ rule, path: source }) =>
          rule === "runtime-manager" && source === file,
      ),
    ).toBe(true);
});

test("configuration discovery shares lockfile presence without parsing lock contents", () => {
  for (const file of ["bun.lock", "uv.lock", "tools/bun.lock", "tools/uv.lock"])
    expect(toolchainInputKind(file)).toBe("presence");
  for (const file of [
    "action.yml",
    "tools/action.yaml",
    ".github/workflows/ci.yml",
    "package.json",
    ".node-version",
  ])
    expect(toolchainInputKind(file)).toBe("config");
  for (const file of ["source.ts", "example/bun.lock.txt", "uv.lock.backup"])
    expect(toolchainInputKind(file)).toBeUndefined();
  expect(
    fixture({
      "bun.lock": "invalid opaque content",
      "uv.lock": "invalid opaque content",
      "stll-toolchain.json": JSON.stringify({
        optOuts: [
          { rule: "dependabot-policy", reason: "Lockfile presence fixture" },
        ],
      }),
    }),
  ).toEqual([]);
});

test("Docker action policy opt-outs require a tracked explicit reason", () => {
  const action =
    "runs: {using: composite, steps: [{uses: 'docker://alpine:3'}]}";
  const base = {
    "action.yml": action,
    "stll-toolchain.json": JSON.stringify({
      optOuts: [{ rule: "dependabot-policy", reason: "Action fixture" }],
    }),
  };
  expect(fixture(base).some(({ rule }) => rule === "action-pins")).toBe(true);
  expect(
    fixture({
      ...base,
      "stll-toolchain.json": JSON.stringify({
        optOuts: [
          { rule: "dependabot-policy", reason: "Action fixture" },
          {
            rule: "action-pins",
            reason: "Repository maintains Docker image action digest policy",
          },
        ],
      }),
    }),
  ).toEqual([]);
});

test("permitted named rules have reasoned opt-outs; mandatory and malformed choices fail", () => {
  expect(new Set(toolchainRules).size).toBe(toolchainRules.length);
  for (const rule of toolchainRules) {
    if (rule === "node-engine" || rule === "cloud-setup-drift") {
      expect(() =>
        parseToolchainConfiguration({
          optOuts: [{ rule, reason: "Explicit repository decision" }],
        }),
      ).toThrow(`${rule} cannot be opted out`);
      continue;
    }
    expect(
      parseToolchainConfiguration({
        optOuts: [{ rule, reason: "Explicit repository decision" }],
      }).disabled.has(rule),
    ).toBe(true);
    expect(() =>
      parseToolchainConfiguration({ optOuts: [{ rule, reason: " " }] }),
    ).toThrow();
  }
  for (const input of [
    { optOuts: [{ rule: "typo", reason: "reason" }] },
    { optOuts: true },
    { optOuts: [], skip: true },
    { optOuts: [{ rule: "bun-pins", reason: "a", path: "any" }] },
    {
      optOuts: [
        { rule: "bun-pins", reason: "a" },
        { rule: "bun-pins", reason: "b" },
      ],
    },
  ])
    expect(() => parseToolchainConfiguration(input)).toThrow();
});

test("untracked and invalid opt-outs cannot conceal a failing runtime", () => {
  const failing = { ".node-version": "0.0.0\n" };
  const config = JSON.stringify({
    optOuts: [{ rule: "node-version", reason: "Separate runtime requirement" }],
  });
  expect(fixture({ ...failing, "stll-toolchain.json": config })).toEqual([]);
  expect(
    fixture(failing, { "stll-toolchain.json": config }).map(
      (entry) => entry.rule,
    ),
  ).toEqual(["node-version"]);
  expect(
    fixture({ ...failing, "stll-toolchain.json": "{}" }).map(
      (entry) => entry.rule,
    ),
  ).toEqual(["node-version"]);
  expect(
    fixture({ ...failing, "stll-toolchain.json": '{"optOuts":true}' }).map(
      (entry) => entry.rule,
    ),
  ).toEqual(["configuration", "node-version"]);
});

test("policy rejects schema drift, missing pins, inconsistent TS layouts and invalid SHAs", () => {
  expect(policy.packages).toEqual(
    Object.fromEntries(packagePinKeys.map((key) => [key, toolchain[key]])),
  );
  for (const key of [
    ...packagePinKeys,
    "bun",
    "typescript",
    "node",
    "python",
    "rust",
    "rustCompilerDevelopment",
  ])
    expect(() => parseToolchainPolicy({ ...toolchain, [key]: null })).toThrow();
  for (const key of packagePinKeys)
    expect(() =>
      parseToolchainPolicy({ ...toolchain, [key]: "^1.2.3" }),
    ).toThrow();
  expect(() =>
    parseToolchainPolicy({ ...toolchain, schemaVersion: 2 }),
  ).toThrow();
  expect(() =>
    parseToolchainPolicy({ ...toolchain, typescript: "0.0.0" }),
  ).toThrow();
  expect(() =>
    parseToolchainPolicy({
      ...toolchain,
      actions: { checkout: { sha: "main", version: "v1" } },
    }),
  ).toThrow();
  expect(() =>
    parseToolchainPolicy({
      ...toolchain,
      dependabot: { ...toolchain.dependabot, cooldown: { defaultDays: 0 } },
    }),
  ).toThrow();
});

test("all package and runtime diagnostics survive orchestration and only named rules opt out", () => {
  const files = {
    "package.json": JSON.stringify({
      devDependencies: { oxlint: "latest" },
      packageManager: `bun@${policy.bun}`,
    }),
    ".node-version": "0.0.0",
    "stll-toolchain.json": JSON.stringify({
      optOuts: [{ rule: "dependabot-policy", reason: "Dependency fixture" }],
    }),
  };
  expect(fixture(files).map((entry) => entry.rule)).toEqual([
    "package-pins",
    "node-version",
  ]);
  expect(
    fixture({
      ...files,
      "stll-toolchain.json": JSON.stringify({
        optOuts: [
          { rule: "dependabot-policy", reason: "Dependency fixture" },
          { rule: "node-version", reason: "Separate runtime" },
        ],
      }),
    }).map((entry) => entry.rule),
  ).toEqual(["package-pins"]);
});

test("GitHub origin identity reaches prefixed workflow selector validation", () => {
  const checkout = policy.actions["actions/checkout"];
  const setup = policy.actions["actions/setup-node"];
  if (checkout === undefined || setup === undefined)
    throw new Error("Missing workflow action pins");
  for (const origin of [
    "https://github.com/stella/example.git",
    "git@github.com:stella/example.git",
    "ssh://git@github.com/stella/example.git",
    "https://github.com/stella/example",
    "https://github.com/foreign/example.git",
  ]) {
    const root = mkdtempSync(path.join(tmpdir(), "stll-checkout-binding-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["remote", "add", "origin", origin], { cwd: root });
      mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
      writeFileSync(path.join(root, ".node-version"), policy.node);
      writeFileSync(
        path.join(root, "stll-toolchain.json"),
        JSON.stringify({
          optOuts: [
            { rule: "dependabot-policy", reason: "Workflow identity fixture" },
          ],
        }),
      );
      writeFileSync(
        path.join(root, ".github/workflows/ci.yml"),
        `jobs:\n  test:\n    steps:\n      - uses: actions/checkout@${checkout.sha} # ${checkout.version}\n        with: {repository: stella/example, path: source}\n      - uses: actions/setup-node@${setup.sha} # ${setup.version}\n        with: {node-version-file: source/.node-version}`,
      );
      execFileSync("git", ["add", "."], { cwd: root });
      const diagnostics = checkToolchain({ root, policy });
      expect(diagnostics.some(({ rule }) => rule === "runtime-workflow")).toBe(
        origin.includes("foreign"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("configuration readers accept only resolved targets inside the tracked tree", () => {
  for (const target of [
    "outside",
    "untracked",
    "tracked",
    "parent-directory",
  ]) {
    const workspace = mkdtempSync(path.join(tmpdir(), "stll-config-boundary-"));
    const root = path.join(workspace, "repository");
    mkdirSync(root);
    execFileSync("git", ["init", "-q", root]);
    try {
      if (target === "parent-directory") {
        mkdirSync(path.join(root, "tools"));
        writeFileSync(path.join(root, "tools/.node-version"), policy.node);
        execFileSync("git", ["add", "."], { cwd: root });
        rmSync(path.join(root, "tools"), { recursive: true });
        mkdirSync(path.join(workspace, "tools"));
        writeFileSync(path.join(workspace, "tools/.node-version"), policy.node);
        symlinkSync(path.join(workspace, "tools"), path.join(root, "tools"));
      } else {
        const aliasTarget =
          target === "outside"
            ? path.join(workspace, ".nvmrc")
            : path.join(root, ".nvmrc");
        writeFileSync(aliasTarget, policy.node);
        symlinkSync(aliasTarget, path.join(root, ".node-version"));
        execFileSync("git", ["add", ".node-version"], { cwd: root });
        if (target === "tracked")
          execFileSync("git", ["add", ".nvmrc"], { cwd: root });
      }
      const diagnostics = checkToolchain({ root, policy });
      if (target === "tracked") {
        expect(diagnostics).toEqual([]);
        continue;
      }
      expect(diagnostics).toEqual([
        {
          rule: "configuration",
          path:
            target === "parent-directory"
              ? "tools/.node-version"
              : ".node-version",
          line: 1,
          message: "cannot read tracked configuration file",
        },
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("a reasoned opt-out cannot hide a Node support range outside the shared series", () => {
  const diagnostics = fixture({
    "package.json": JSON.stringify({ engines: { node: "<26" } }),
    "stll-toolchain.json": JSON.stringify({
      optOuts: [{ rule: "node-engine", reason: "Alternate runtime" }],
    }),
  });
  expect(diagnostics.some(({ rule }) => rule === "node-engine")).toBe(true);
  expect(
    diagnostics.some(
      ({ rule, message }) =>
        rule === "configuration" && message.includes("cannot be opted out"),
    ),
  ).toBe(true);
});

test("repository configuration accepts an explicit cloud declaration without changing opt-outs", () => {
  const cloud = {
    services: ["postgres", "valkey"],
    envFile: ".env",
    install: "bun install --frozen-lockfile",
  } satisfies NonNullable<ReturnType<typeof parseCloudSetup>>;
  const configured = parseToolchainConfiguration({
    optOuts: [{ rule: "bun-pins", reason: "Repository decision" }],
    cloud,
  });
  expect(configured.cloud).toEqual(cloud);
  expect(parseToolchainConfiguration({ cloud }).cloud).toEqual(cloud);
  expect([...configured.disabled]).toEqual(["bun-pins"]);
  expect(parseToolchainConfiguration({ optOuts: [] }).cloud).toBeUndefined();
  expect(
    parseToolchainConfiguration({
      optOuts: [],
      cloud: { ...cloud, services: [] },
    }).cloud?.services,
  ).toEqual([]);
});

test("unknown root keys and malformed cloud declarations fail through the tracked configuration boundary", () => {
  const cloud = {
    services: [],
    install: "bun install --frozen-lockfile",
    envFile: ".env",
  };
  for (const input of [
    { optOuts: [], cloud, extra: true },
    { optOuts: [], cloud: null },
    { optOuts: [], cloud: { ...cloud, services: ["mysql"] } },
    { optOuts: [], cloud: { ...cloud, services: ["valkey", "valkey"] } },
    { optOuts: [], cloud: { ...cloud, install: "bun install" } },
    { optOuts: [], cloud: { ...cloud, environment: "test" } },
    { optOuts: [], cloud: { ...cloud, envFile: "../.env" } },
  ]) {
    expect(() => parseToolchainConfiguration(input)).toThrow();
    expect(
      fixture({ "stll-toolchain.json": JSON.stringify(input) }).some(
        ({ rule }) => rule === "configuration",
      ),
    ).toBe(true);
  }
  const invalid = fixture({
    ".node-version": "latest",
    "stll-toolchain.json": JSON.stringify({
      optOuts: [{ rule: "node-version", reason: "Repository decision" }],
      cloud: null,
    }),
  });
  expect(invalid.some(({ rule }) => rule === "configuration")).toBe(true);
  expect(invalid.some(({ rule }) => rule === "node-version")).toBe(true);
});

const cloudDeclaration = {
  services: [],
  install: "bun install --frozen-lockfile",
  envFile: ".env.cloud",
} as const;
const cloudFixtureFiles = () => ({
  "stll-toolchain.json": JSON.stringify({
    optOuts: [],
    cloud: cloudDeclaration,
  }),
  ".node-version": "26.10.0\n",
});

test("cloud setup guard rejects missing, drifted and stray tracked scripts and accepts generated bytes", () => {
  const files = cloudFixtureFiles();
  const script = generateCloudSetup({
    policy,
    cloud: { ...cloudDeclaration, services: [] },
    nodeVersion: "26.10.0",
  });
  expect(fixture({ ...files, [cloudSetupPath]: script })).toEqual([]);
  for (const text of [undefined, script + "\n", "#!/bin/bash\nexit 0\n"])
    expect(
      fixture({
        ...files,
        ...(text === undefined ? {} : { [cloudSetupPath]: text }),
      }).some(({ rule }) => rule === "cloud-setup-drift"),
    ).toBe(true);
  expect(
    fixture({ [cloudSetupPath]: script }).some(
      ({ rule }) => rule === "cloud-setup-drift",
    ),
  ).toBe(true);
  expect(fixture({}, { [cloudSetupPath]: script })).toEqual([]);
});

test("cloud generation requires an exact tracked root Node patch within the shared series", () => {
  const files = cloudFixtureFiles();
  for (const nodeVersion of [
    undefined,
    "26",
    "26.x",
    "26.10",
    "24.15.0",
    "26.10.0-rc.1",
  ])
    expect(
      fixture({
        "stll-toolchain.json": files["stll-toolchain.json"],
        ...(nodeVersion === undefined ? {} : { ".node-version": nodeVersion }),
      }).some(({ rule }) => rule === "cloud-setup-drift"),
    ).toBe(true);
  expect(
    fixture(
      { "stll-toolchain.json": files["stll-toolchain.json"] },
      { ".node-version": "26.10.0" },
    ).some(({ rule }) => rule === "cloud-setup-drift"),
  ).toBe(true);
});

test("published engine floors permit only an exact selector in the declared workflow job", () => {
  const setup = policy.actions["actions/setup-node"];
  if (setup === undefined) throw new Error("Missing setup-node action policy");
  const declaration = {
    package: "packages/library",
    workflow: ".github/workflows/ci.yml",
    job: "node-floor",
  };
  const floorStep = `      - uses: actions/setup-node@${setup.sha} # ${setup.version}\n        with: {node-version: 20.10.0}`;
  const ordinaryStep = `      - uses: actions/setup-node@${setup.sha} # ${setup.version}\n        with: {node-version-file: .node-version}`;
  const workflow = `jobs:\n  node-floor:\n    steps:\n${floorStep}\n  ordinary:\n    steps:\n${ordinaryStep}\n`;
  const config = {
    optOuts: [
      { rule: "dependabot-policy", reason: "Published engine floor fixture" },
    ],
    engineFloors: [declaration],
  };
  const base = {
    "package.json": JSON.stringify({
      private: true,
      workspaces: ["packages/*"],
    }),
    "packages/library/package.json": JSON.stringify({
      name: "@example/library",
      version: "1.0.0",
      engines: { node: ">=20.10.0" },
    }),
    ".node-version": policy.node,
    ".github/workflows/ci.yml": workflow,
    "stll-toolchain.json": JSON.stringify(config),
  };
  expect(fixture(base)).toEqual([]);
  const disabledWorkflow = JSON.stringify({
    ...config,
    optOuts: [
      ...config.optOuts,
      { rule: "runtime-workflow", reason: "Scoped floor validation fixture" },
    ],
  });
  expect(fixture({ ...base, "stll-toolchain.json": disabledWorkflow })).toEqual(
    [],
  );
  const mismatchStep = floorStep.replace("20.10.0", "22.10.0");
  for (const steps of [
    [floorStep, mismatchStep],
    [mismatchStep, floorStep],
  ]) {
    const diagnostics = fixture({
      ...base,
      "stll-toolchain.json": disabledWorkflow,
      ".github/workflows/ci.yml": workflow.replace(floorStep, steps.join("\n")),
    });
    expect(diagnostics.map(({ rule }) => rule)).toEqual(["configuration"]);
    expect(diagnostics.at(0)?.message).toContain(
      `${declaration.workflow}:${declaration.job}`,
    );
  }
  expect(
    fixture({
      ...base,
      "package.json": JSON.stringify({
        name: "@example/root-library",
        version: "1.0.0",
        engines: { node: ">=20.10.0" },
        workspaces: ["packages/*"],
      }),
      "stll-toolchain.json": JSON.stringify({
        ...config,
        engineFloors: [{ ...declaration, package: "." }],
      }),
    }),
  ).toEqual([]);
  for (const selector of [
    "22.10.0",
    "20.9.9",
    "20",
    "20.x",
    "^20.10.0",
    "20.10.0-rc.1",
  ]) {
    const diagnostics = fixture({
      ...base,
      ".github/workflows/ci.yml": workflow.replace(
        "node-version: 20.10.0",
        `node-version: '${selector}'`,
      ),
    });
    expect(
      diagnostics.some(
        ({ rule }) => rule === "configuration" || rule === "runtime-workflow",
      ),
    ).toBe(true);
  }
  const undeclared = fixture({
    ...base,
    ".github/workflows/ci.yml": workflow.replace(ordinaryStep, floorStep),
  });
  expect(
    undeclared.some(
      ({ rule, path: file }) =>
        rule === "runtime-workflow" && file === declaration.workflow,
    ),
  ).toBe(true);
  expect(undeclared.some(({ rule }) => rule === "configuration")).toBe(false);
  const floatingAction = fixture({
    ...base,
    ".github/workflows/ci.yml": workflow.replace(
      `actions/setup-node@${setup.sha}`,
      "actions/setup-node@main",
    ),
  });
  expect(floatingAction.some(({ rule }) => rule === "action-pins")).toBe(true);
  const wrongGlobal = fixture({ ...base, ".node-version": "20.10.0" });
  expect(wrongGlobal.some(({ rule }) => rule === "node-version")).toBe(true);
  for (const entry of [
    { ...declaration, package: "packages/missing" },
    { ...declaration, workflow: ".github/workflows/missing.yml" },
    { ...declaration, job: "missing" },
  ]) {
    expect(
      fixture({
        ...base,
        "stll-toolchain.json": JSON.stringify({
          ...config,
          engineFloors: [entry],
        }),
      }).some(({ rule }) => rule === "configuration"),
    ).toBe(true);
  }
  const noSetup = fixture({
    ...base,
    ".github/workflows/ci.yml": workflow.replace(
      floorStep,
      "      - run: echo floor",
    ),
  });
  expect(noSetup.some(({ rule }) => rule === "configuration")).toBe(true);
  for (const job of [
    `uses: actions/setup-node@${setup.sha} # ${setup.version}\n    with: {node-version: 20.10.0}`,
    `uses: example/workflows/.github/workflows/node.yml@${"a".repeat(40)}\n    steps:\n${floorStep}`,
    "steps: null",
  ]) {
    const diagnostics = fixture({
      ...base,
      ".github/workflows/ci.yml": `jobs:\n  node-floor:\n    ${job}\n`,
    });
    expect(diagnostics.some(({ rule }) => rule === "configuration")).toBe(true);
  }
  for (const manifest of [
    {
      name: "@example/library",
      version: "1.0.0",
      private: true,
      engines: { node: ">=20.10.0" },
    },
    { name: "@example/library", version: "1.0.0" },
    {
      name: "@example/library",
      version: "1.0.0",
      engines: { node: "invalid" },
    },
  ]) {
    expect(
      fixture({
        ...base,
        "packages/library/package.json": JSON.stringify(manifest),
      }).some(({ rule }) => rule === "configuration"),
    ).toBe(true);
  }
});

test("engine floor configuration is closed, scoped and independent of optional opt-outs", () => {
  const entry = {
    package: "packages/library",
    workflow: ".github/workflows/ci.yml",
    job: "node-floor",
  };
  const configured = parseToolchainConfiguration({ engineFloors: [entry] });
  expect(configured.disabled.size).toBe(0);
  expect(configured.engineFloors).toEqual([entry]);
  for (const engineFloors of [
    null,
    true,
    "floor",
    [null],
    [{ ...entry, reason: "extra" }],
    [{ ...entry, job: "" }],
    [{ ...entry, package: "../library" }],
    [{ ...entry, package: "/packages/library" }],
    [{ ...entry, package: "C:/packages/library" }],
    [{ ...entry, workflow: "README.md" }],
    [entry, entry],
  ])
    expect(() => parseToolchainConfiguration({ engineFloors })).toThrow();
});
