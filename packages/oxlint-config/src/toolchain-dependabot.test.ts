/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { stringify } from "yaml";

import {
  checkDependabot,
  dependabotRules,
  generateDependabotConfig,
} from "./toolchain-dependabot";
import {
  canonicalDockerRuntime,
  ownedDockerImageAliases,
} from "./toolchain-images";

type Policy = Parameters<typeof checkDependabot>[0]["policy"];
const policy = {
  schedule: {
    interval: "weekly",
    day: "saturday",
    time: "07:00",
    timezone: "Europe/Prague",
  },
  cooldown: { defaultDays: 5 },
  groups: {
    dependencies: { patterns: ["*"], updateTypes: ["minor", "patch"] },
  },
  ignoredPackages: ["oxlint", "typescript", "@oxlint/plugins"],
  ignoredActions: ["actions/checkout", "oven-sh/setup-bun"],
  ignoredImages: ["node", "python", "oven/bun"],
} satisfies Policy;

const update = (ecosystem = "npm", directory = "/") => ({
  "package-ecosystem": ecosystem,
  directory,
  schedule: policy.schedule,
  cooldown: { "default-days": policy.cooldown.defaultDays },
  groups: Object.fromEntries(
    Object.entries(policy.groups).map(([name, group]) => [
      name,
      { patterns: group.patterns, "update-types": group.updateTypes },
    ]),
  ),
  ignore: (ecosystem === "npm" || ecosystem === "bun"
    ? policy.ignoredPackages
    : ecosystem === "github-actions"
      ? policy.ignoredActions
      : ecosystem === "docker"
        ? policy.ignoredImages
        : []
  ).map((name) => ({ "dependency-name": name })),
});

const check = (
  text: string,
  manifests: Record<string, string> = { "package.json": "{}" },
) =>
  checkDependabot({
    files: { ...manifests, ".github/dependabot.yml": text },
    policy,
  });
const ignoreDeclaration = (name: string) =>
  stringify({ "dependency-name": name }).trim();

const config = (updates: unknown[] = [update()]) =>
  stringify({ version: 2, updates });

describe("Dependabot policy", () => {
  test("generated YAML remains valid as new manifest roots and ecosystems are added", () => {
    const manifests = {
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/member/package.json": "{}",
      "standalone/package.json": "{}",
      ".github/workflows/ci.yml": "jobs: {}",
      "scripts/requirements.txt": "requests",
      "images/Dockerfile.production": "FROM node:24.14.0",
      "containers/Containerfile": "FROM python:3.14.4",
      "python/pyproject.toml": "[project]\nname = 'example'",
      "rust/Cargo.toml":
        '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/excluded"]',
      "rust/crates/member/Cargo.toml": "[package]\nname = 'member'",
      "rust/crates/excluded/Cargo.toml": "[package]\nname = 'excluded'",
    };
    const files: Record<string, string> = {};
    for (const [file, text] of Object.entries(manifests)) {
      files[file] = text;
      const generated = generateDependabotConfig({ files, policy });
      expect(check(generated, files)).toEqual([]);
      expect(
        generateDependabotConfig({
          files: Object.fromEntries(Object.entries(files).reverse()),
          policy,
        }),
      ).toBe(generated);
    }
    const generated = generateDependabotConfig({ files, policy });
    expect(generated).not.toContain("/packages/member");
    expect(generated).not.toContain("/rust/crates/member");
    expect(generated).toContain("/rust/crates/excluded");
    expect(
      check(generated, {
        ...files,
        "new/Cargo.toml": "[package]\nname = 'new'",
      }).some(({ message }) => message.includes("/new")),
    ).toBe(true);
    expect(check(generateDependabotConfig({ files: {}, policy }), {})).toEqual(
      [],
    );
  });

  test("uses Bun ecosystem for package-manager and lockfile roots while retaining npm roots", () => {
    const files = {
      "package.json": JSON.stringify({
        packageManager: "bun@1.4.3",
        workspaces: ["packages/*"],
      }),
      "packages/member/package.json": "{}",
      "locked/package.json": "{}",
      "locked/bun.lock": "{}",
      "npm/package.json": JSON.stringify({ packageManager: "npm@11.6.0" }),
      "pnpm/package.json": JSON.stringify({ packageManager: "pnpm@10.0.0" }),
      "yarn/package.json": JSON.stringify({ packageManager: "yarn@4.0.0" }),
    };
    const good = config([
      update("bun"),
      update("bun", "/locked"),
      update("npm", "/npm"),
      update("npm", "/pnpm"),
      update("npm", "/yarn"),
    ]);
    expect(check(good, files)).toEqual([]);
    const generated = generateDependabotConfig({ files, policy });
    expect(check(generated, files)).toEqual([]);
    expect(generated).not.toContain("/packages/member");
    expect(
      check(
        good.replace("package-ecosystem: bun", "package-ecosystem: npm"),
        files,
      ).some(({ message }) =>
        message.includes("add a bun update entry covering /"),
      ),
    ).toBe(true);
    for (const name of policy.ignoredPackages) {
      const bad = good.replace(
        ignoreDeclaration(name),
        ignoreDeclaration("other"),
      );
      expect(bad).not.toBe(good);
      expect(
        check(bad, files).some(({ message }) =>
          message.includes(`bun: ignore all updates for shared pin ${name}`),
        ),
      ).toBe(true);
    }
  });

  test("selects uv for lockfile or explicit tool roots and pip for independent requirements", () => {
    const files = {
      "locked/pyproject.toml": "[project]\nname = 'locked'",
      "locked/uv.lock": "version = 1",
      "configured/pyproject.toml":
        "[project]\nname = 'configured'\n[tool.uv]\npackage = true",
      "standalone/requirements.txt": "requests",
      "plain/pyproject.toml": "[project]\nname = 'plain'",
    };
    const good = config([
      update("uv", "/locked"),
      update("uv", "/configured"),
      update("pip", "/standalone"),
      update("pip", "/plain"),
    ]);
    expect(check(good, files)).toEqual([]);
    expect(check(generateDependabotConfig({ files, policy }), files)).toEqual(
      [],
    );
    expect(
      check(
        good.replace("package-ecosystem: uv", "package-ecosystem: pip"),
        files,
      ).some(({ message }) =>
        message.includes("add a uv update entry covering /locked"),
      ),
    ).toBe(true);
  });

  test("uv workspace members inherit the root update entry while excluded and independent projects stay separate", () => {
    const files = {
      "pyproject.toml":
        '[project]\nname = "workspace"\n[tool.uv.workspace]\nmembers = ["packages/*"]\nexclude = ["packages/excluded"]',
      "uv.lock": "",
      "packages/member/pyproject.toml": '[project]\nname = "member"',
      "packages/excluded/pyproject.toml": '[project]\nname = "excluded"',
      "independent/pyproject.toml": '[project]\nname = "independent"',
    };
    const good = config([
      update("uv"),
      update("pip", "/packages/excluded"),
      update("pip", "/independent"),
    ]);
    expect(check(good, files)).toEqual([]);
    const generated = generateDependabotConfig({ files, policy });
    expect(check(generated, files)).toEqual([]);
    expect(generated).not.toContain("/packages/member");
    expect(generated).toContain("/packages/excluded");
    expect(generated).toContain("/independent");
    expect(
      check(
        config([
          update("pip", "/packages/excluded"),
          update("pip", "/independent"),
        ]),
        files,
      ).some(({ message }) =>
        message.includes("add a uv update entry covering /"),
      ),
    ).toBe(true);
    const changed = {
      ...files,
      "pyproject.toml": files["pyproject.toml"].replace(
        'members = ["packages/*"]',
        'members = ["different/*"]',
      ),
    };
    expect(changed["pyproject.toml"]).not.toBe(files["pyproject.toml"]);
    expect(
      check(good, changed).some(({ message }) =>
        message.includes("add a pip update entry covering /packages/member"),
      ),
    ).toBe(true);
    expect(
      check(generateDependabotConfig({ files: changed, policy }), changed),
    ).toEqual([]);
  });

  test("requirements-prefixed text manifests use the same reader and ecosystem predicate", () => {
    for (const name of [
      "requirements.txt",
      "requirements_dev.txt",
      "requirements-ci.txt",
      "requirements.prod.txt",
      "requirements-extra.txt",
    ]) {
      const files = { [`python/${name}`]: "requests==2.32.0" };
      expect(check(config([update("pip", "/python")]), files)).toEqual([]);
      expect(check(generateDependabotConfig({ files, policy }), files)).toEqual(
        [],
      );
      expect(
        check(config([]), files).some(({ message }) =>
          message.includes("add a pip update entry covering /python"),
        ),
      ).toBe(true);
    }
    const files = { "legal-act.txt": "text", "docs/contract.txt": "text" };
    expect(checkDependabot({ files, policy })).toEqual([]);
  });

  test("does not require configuration in repositories without an ecosystem", () => {
    expect(
      checkDependabot({ files: { "README.md": "hello" }, policy }),
    ).toEqual([]);
  });

  test("requires configuration and reports its canonical path", () => {
    expect(
      checkDependabot({ files: { "package.json": "{}" }, policy }),
    ).toEqual([
      {
        rule: "dependabot-policy",
        path: ".github/dependabot.yml",
        line: 1,
        message:
          "add a Dependabot configuration for the repository's package ecosystems",
      },
    ]);
  });

  test("accepts yaml extension and rejects ambiguous duplicate configurations", () => {
    const files = { "package.json": "{}", ".github/dependabot.yaml": config() };
    expect(checkDependabot({ files, policy })).toEqual([]);
    expect(
      checkDependabot({
        files: { ...files, ".github/dependabot.yml": config() },
        policy,
      }).map(({ message }) => message),
    ).toContain("keep one Dependabot configuration file");
  });

  test("accepts a complete policy and diagnoses mutations of every policy field", () => {
    const good = config();
    expect(check(good)).toEqual([]);
    const mutations = [
      ["version: 2", "version: 1"],
      ["weekly", "daily"],
      ["saturday", "monday"],
      ["07:00", "08:00"],
      ["Europe/Prague", "UTC"],
      ["default-days: 5", "default-days: 0"],
      ["dependencies:", "other:"],
      ['"*"', '"a*"'],
      ["minor", "major"],
      ["patch", "major"],
      ["dependency-name: oxlint", "dependency-name: oxfmt"],
      ["dependency-name: typescript", "dependency-name: other"],
      [ignoreDeclaration("@oxlint/plugins"), ignoreDeclaration("other")],
    ];
    const exercised = new Set<string>();
    for (const [before, after] of mutations) {
      if (before === undefined || after === undefined)
        throw new Error("invalid mutation fixture");
      const bad = good.replace(before, after);
      expect(bad).not.toBe(good);
      const diagnostics = check(bad);
      expect(diagnostics.length).toBeGreaterThan(0);
      for (const diagnostic of diagnostics) exercised.add(diagnostic.rule);
    }
    expect([...exercised].sort()).toEqual([...dependabotRules].sort());
  });

  test("infers GitHub Actions from root and nested action metadata", () => {
    for (const file of [
      "action.yml",
      "action.yaml",
      "actions/composite/action.yml",
      "nested/action.yaml",
    ]) {
      const files = {
        [file]: "name: Example\nruns:\n  using: composite\n  steps: []",
      };
      expect(check(config([update("github-actions")]), files)).toEqual([]);
      expect(check(generateDependabotConfig({ files, policy }), files)).toEqual(
        [],
      );
      expect(
        check(config([]), files).some(({ message }) =>
          message.includes("github-actions"),
        ),
      ).toBe(true);
    }
  });

  test("checks action ignores separately from npm package ignores", () => {
    const files = { ".github/workflows/ci.yml": "jobs: {}" };
    const good = config([update("github-actions")]);
    expect(check(good, files)).toEqual([]);
    for (const name of policy.ignoredActions) {
      expect(
        check(good.replace(name, "other/action"), files).some(({ message }) =>
          message.includes(name),
        ),
      ).toBe(true);
    }
  });

  test("requires every Docker root and full ignores for shared base images", () => {
    const files = {
      Dockerfile: "FROM node:24.14.0",
      "worker/Dockerfile.production": "FROM oven/bun:1.4.3",
      "python/Containerfile": "FROM python:3.14.4",
    };
    const good = generateDependabotConfig({ files, policy });
    expect(check(good, files)).toEqual([]);
    for (const image of policy.ignoredImages) {
      const bad = good.replace(
        `dependency-name: ${image}`,
        "dependency-name: other-image",
      );
      expect(bad).not.toBe(good);
      expect(
        check(bad, files).some(({ message }) => message.includes(image)),
      ).toBe(true);
    }
    expect(
      check(config([update("docker")]), files).filter(({ message }) =>
        message.includes("covering"),
      ).length,
    ).toBe(2);
    expect(
      check(
        config([
          {
            ...update("docker"),
            ignore: policy.ignoredImages.map((image) => ({
              "dependency-name": image,
              "update-types": ["version-update:semver-major"],
            })),
          },
        ]),
        files,
      ).some(({ message }) => message.includes("ignore all updates")),
    ).toBe(true);
  });

  test("ignores the complete accepted image alias class regardless of Dockerfile instructions", () => {
    const files = { Dockerfile: "FROM alpine:3.22" };
    const good = generateDependabotConfig({ files, policy });
    expect(check(good, files)).toEqual([]);
    const aliases = ownedDockerImageAliases(policy.ignoredImages);
    for (const alias of aliases) {
      expect(good).toContain(`dependency-name: ${alias}`);
      expect(policy.ignoredImages).toContain(canonicalDockerRuntime(alias));
      expect(canonicalDockerRuntime(`${alias}:1.2.3@sha256:abc`)).toBe(
        `${canonicalDockerRuntime(alias)}:1.2.3@sha256:abc`,
      );
      expect(
        check(
          good.replace(
            `dependency-name: ${alias}\n`,
            "dependency-name: wrong\n",
          ),
          files,
        ).some(({ message }) => message.includes(alias)),
      ).toBe(true);
    }
    for (const content of [
      "FROM node:24.14.0",
      "ARG BASE=docker.io/library/node:24.14.0\nFROM $BASE",
      "FROM alpine:3.22\nRUN <<EOF\nFROM docker.io/library/node:latest\nEOF",
    ]) {
      const changed = { Dockerfile: content };
      expect(generateDependabotConfig({ files: changed, policy })).toBe(good);
      expect(check(good, changed)).toEqual([]);
    }
    expect(canonicalDockerRuntime("ghcr.io/node:1.2.3")).toBe(
      "ghcr.io/node:1.2.3",
    );
    expect(
      generateDependabotConfig({
        files: { "README.md": "FROM node:24.14.0" },
        policy,
      }),
    ).not.toContain("docker");
  });

  test("rejects restricted ignores and cooldown overrides", () => {
    const base = update();
    const ignores = [
      base.ignore.map((entry) => ({ ...entry, versions: ["1.x"] })),
      base.ignore.map((entry) => ({
        ...entry,
        "update-types": ["version-update:semver-major"],
      })),
    ];
    for (const ignore of ignores)
      expect(
        check(config([{ ...base, ignore }])).some(({ message }) =>
          message.includes("ignore all updates"),
        ),
      ).toBe(true);
    for (const override of [
      { exclude: ["*"] },
      { include: ["one"] },
      { "semver-patch-days": 0 },
    ]) {
      expect(
        check(
          config([{ ...base, cooldown: { ...base.cooldown, ...override } }]),
        ).some(({ message }) => message.includes("cooldown")),
      ).toBe(true);
    }
  });

  test("rejects extra groups and semantic group overrides", () => {
    const base = update();
    const groups = [
      { ...base.groups, extra: { patterns: ["*"] } },
      {
        dependencies: {
          patterns: ["*"],
          "update-types": ["minor", "patch"],
          "exclude-patterns": ["*"],
        },
      },
      {
        dependencies: {
          patterns: ["*"],
          "update-types": ["minor", "patch"],
          "applies-to": "security-updates",
        },
      },
    ];
    for (const value of groups)
      expect(
        check(config([{ ...base, groups: value }])).some(({ message }) =>
          message.includes("groups"),
        ),
      ).toBe(true);
  });

  test("infers required ecosystems from production-shaped manifest paths", () => {
    const manifests = {
      "package.json": "{}",
      ".github/workflows/ci.yaml": "jobs: {}",
      "python/pyproject.toml": "[project]\nname = 'package'",
      "scripts/requirements-dev.txt": "requests",
      "rust/Cargo.toml": "[package]\nname = 'package'",
    };
    const updates = [
      update(),
      update("github-actions"),
      update("pip", "/python"),
      update("pip", "/scripts"),
      update("cargo", "/rust"),
    ];
    expect(check(config(updates), manifests)).toEqual([]);
    for (const [index, entry] of updates.entries()) {
      expect(
        check(
          config(updates.filter((_, other) => other !== index)),
          manifests,
        ).some(({ message }) =>
          message.includes(
            `add a ${entry["package-ecosystem"]} update entry covering ${entry.directory}`,
          ),
        ),
      ).toBe(true);
    }
  });

  test("collapses npm workspaces while preserving standalone and excluded packages", () => {
    const files = {
      "package.json": JSON.stringify({
        workspaces: { packages: ["packages/*", "!packages/excluded"] },
      }),
      "packages/member/package.json": "{}",
      "packages/excluded/package.json": "{}",
      "independent/package.json": "{}",
    };
    const entries = [
      update(),
      update("npm", "/packages/excluded"),
      update("npm", "/independent"),
    ];
    expect(check(config(entries), files)).toEqual([]);
    expect(
      check(config([update()]), files).map(({ message }) => message),
    ).toEqual([
      "add a npm update entry covering /packages/excluded",
      "add a npm update entry covering /independent",
    ]);
    expect(
      check(config(), {
        "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
        "packages/member/package.json": "{}",
      }),
    ).toEqual([]);
  });

  test("supports directories lists and wildcard coverage without treating root as recursive", () => {
    const files = { "a/package.json": "{}", "b/package.json": "{}" };
    const entry = { ...update(), directory: undefined };
    expect(
      check(config([{ ...entry, directories: ["/a", "/b"] }]), files),
    ).toEqual([]);
    expect(check(config([{ ...entry, directories: ["/*"] }]), files)).toEqual(
      [],
    );
    expect(
      check(config(), files).filter(({ message }) =>
        message.includes("covering"),
      ).length,
    ).toBe(2);
    expect(
      check(
        config([{ ...entry, directory: "/", directories: ["/*"] }]),
        files,
      ).some(({ message }) => message.includes("absolute repository paths")),
    ).toBe(true);
  });

  test("checks every update entry and identifies the failing source line", () => {
    const text = config([
      update(),
      {
        ...update("npm", "/other"),
        schedule: { ...policy.schedule, interval: "daily" },
      },
    ]);
    const diagnostics = check(text);
    expect(diagnostics).toHaveLength(1);
    const diagnostic = diagnostics.at(0);
    if (diagnostic === undefined)
      throw new Error("expected schedule diagnostic");
    expect(text.split("\n").at(diagnostic.line - 1)).toContain("interval:");
  });

  test("rejects disabling updates or only targeting another branch", () => {
    for (const override of [
      { "open-pull-requests-limit": 0 },
      { "target-branch": "release" },
    ])
      expect(
        check(config([{ ...update(), ...override }])).length,
      ).toBeGreaterThan(0);
  });

  test("rejects invalid shapes, malformed YAML and duplicate keys", () => {
    for (const text of [
      "[",
      "null",
      "version: 2\nupdates: {}",
      "version: 2\nupdates:\n - null",
      "version: 2\nversion: 2\nupdates: []",
    ])
      expect(check(text).length).toBeGreaterThan(0);
  });
});
