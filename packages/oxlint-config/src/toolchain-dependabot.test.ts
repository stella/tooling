/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { parseDocument, stringify } from "yaml";

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

const fixtureIgnores = (ecosystem: string) => {
  if (ecosystem === "npm" || ecosystem === "bun") return policy.ignoredPackages;
  if (ecosystem === "github-actions") return policy.ignoredActions;
  if (ecosystem === "docker" || ecosystem === "docker-compose")
    return ownedDockerImageAliases(policy.ignoredImages);
  return [];
};
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
  ignore: fixtureIgnores(ecosystem).map((name) => ({
    "dependency-name": name,
  })),
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
  test("rootless pnpm workspaces own their members while exclusions remain separate", () => {
    const files = {
      "pnpm-workspace.yaml": 'packages: ["packages/*", "!packages/excluded"]',
      "packages/member/package.json": "{}",
      "packages/excluded/package.json": "{}",
      "standalone/package.json": "{}",
    };
    const good = config([
      update(),
      update("npm", "/packages/excluded"),
      update("npm", "/standalone"),
    ]);
    expect(check(good, files)).toEqual([]);
    const generated = generateDependabotConfig({ files, policy });
    expect(check(generated, files)).toEqual([]);
    expect(generated).not.toContain("/packages/member");
    expect(
      check(
        config([
          update("npm", "/packages/member"),
          update("npm", "/packages/excluded"),
          update("npm", "/standalone"),
        ]),
        files,
      ).some(({ message }) => message.includes("covering /")),
    ).toBe(true);
  });

  test("Cargo recursively includes in-tree path dependencies and honors workspace exclusions", () => {
    const files = {
      "Cargo.toml":
        '[workspace]\nmembers=["app"]\nexclude=["excluded"]\n[workspace.dependencies]\nimplicit={path="implicit"}',
      "app/Cargo.toml":
        '[package]\nname="app"\n[dependencies]\nimplicit.workspace=true\nexcluded={path="../excluded"}\nexternal={path="../../external"}',
      "implicit/Cargo.toml":
        '[package]\nname="implicit"\n[target.cfg.dependencies]\nnested={path="../nested"}',
      "nested/Cargo.toml":
        '[package]\nname="nested"\n[build-dependencies]\napp={path="../app"}',
      "excluded/Cargo.toml": '[package]\nname="excluded"',
      "independent/Cargo.toml": '[package]\nname="independent"',
    };
    const good = config([
      update("cargo"),
      update("cargo", "/excluded"),
      update("cargo", "/independent"),
    ]);
    expect(check(good, files)).toEqual([]);
    const generated = generateDependabotConfig({ files, policy });
    expect(check(generated, files)).toEqual([]);
    for (const member of ["app", "implicit", "nested"])
      expect(generated).not.toContain(`/${member}`);
    const noMembers = {
      "Cargo.toml":
        '[package]\nname="root"\n[workspace]\n[dependencies]\nimplicit={path="implicit"}',
      "implicit/Cargo.toml": '[package]\nname="implicit"',
    };
    expect(check(config([update("cargo")]), noMembers)).toEqual([]);
  });

  test("Cargo dependency metadata stays independent and path members are literal directories", () => {
    const files = {
      "Cargo.toml":
        '[package]\nname="root"\n[workspace]\n[dependencies]\nliteral={path="crates/[lib]"}\n[package.metadata.dependencies]\nfake={path="standalone"}\n[target.cfg.metadata.dependencies]\nfake={path="target-metadata"}',
      "crates/[lib]/Cargo.toml": '[package]\nname="literal"',
      "crates/l/Cargo.toml": '[package]\nname="independent"',
      "standalone/Cargo.toml": '[package]\nname="metadata"',
      "target-metadata/Cargo.toml": '[package]\nname="target_metadata"',
    };
    const generated = generateDependabotConfig({ files, policy });
    expect(check(generated, files)).toEqual([]);
    expect(generated).not.toContain("/crates/[lib]");
    for (const directory of ["crates/l", "standalone", "target-metadata"])
      expect(generated).toContain(`/${directory}`);
    expect(check(config([update("cargo")]), files)).toHaveLength(3);
  });

  test("surplus ignores cannot disable updates outside the shared pin set", () => {
    for (const name of ["*", "ox*", "unowned-package"]) {
      const entry = update();
      expect(
        check(
          config([
            {
              ...entry,
              ignore: [...entry.ignore, { "dependency-name": name }],
            },
          ]),
        ).some(({ message }) => message.includes("ignore only packages owned")),
      ).toBe(true);
    }
  });

  test("aliased schedules and update entries preserve time strings for both YAML consumers", () => {
    const timePolicy = {
      ...policy,
      schedule: { ...policy.schedule, time: "17:00" },
    };
    const generated = generateDependabotConfig({
      files: { "package.json": "{}" },
      policy: timePolicy,
    });
    for (const clock of ['"17:00"', "17:00"]) {
      const withAlias = `clock: &clock ${clock}\n${generated.replace('time: "17:00"', "time: *clock")}`;
      const updateBody = generated
        .slice(generated.indexOf("updates:\n") + "updates:\n".length)
        .replace(/^  - /, "  ")
        .replace(/^    /gm, "  ")
        .replace('time: "17:00"', "time: *clock");
      const withUpdateAlias = `clock: &clock ${clock}\nshared: &entry\n${updateBody}\nversion: 2\nupdates:\n  - *entry\n`;
      for (const text of [withAlias, withUpdateAlias]) {
        const diagnostics = checkDependabot({
          files: { "package.json": "{}", ".github/dependabot.yml": text },
          policy: timePolicy,
        });
        expect(
          diagnostics.some(({ message }) =>
            message.includes("quote schedule time"),
          ),
        ).toBe(clock === "17:00");
        if (clock !== "17:00") expect(diagnostics).toEqual([]);
      }
    }
  });

  test("generated schedule times are quoted strings for YAML 1.1 consumers", () => {
    for (const time of ["07:00", "17:00", "23:59"]) {
      const generated = generateDependabotConfig({
        files: { "package.json": "{}" },
        policy: { ...policy, schedule: { ...policy.schedule, time } },
      });
      expect(generated).toContain(`time: "${time}"`);
      const document = parseDocument(generated, { version: "1.1" });
      expect(document.getIn(["updates", 0, "schedule", "time"])).toBe(time);
      expect(
        checkDependabot({
          files: { "package.json": "{}", ".github/dependabot.yml": generated },
          policy: { ...policy, schedule: { ...policy.schedule, time } },
        }),
      ).toEqual([]);
      expect(
        parseDocument(generated, { version: "1.2" }).getIn([
          "updates",
          0,
          "schedule",
          "time",
        ]),
      ).toBe(time);
      if (time === "17:00") {
        const unquoted = generated.replace('time: "17:00"', "time: 17:00");
        expect(unquoted).not.toBe(generated);
        expect(
          checkDependabot({
            files: { "package.json": "{}", ".github/dependabot.yml": unquoted },
            policy: { ...policy, schedule: { ...policy.schedule, time } },
          }).some(({ message }) => message.includes("quote schedule time")),
        ).toBe(true);
      }
    }
  });

  test("Compose and Kubernetes documents derive update roots from shared semantic images", () => {
    const files = {
      "compose.yaml": "services: {app: {image: 'node:26'}}",
      "nested/COMPOSE.OVERRIDE.YAML": "services: {app: {image: 'python:3.13'}}",
      "hidden/.compose.yaml": "services: {app: {image: 'oven/bun:1.4.3'}}",
      "deploy/workload.yaml":
        "apiVersion: apps/v1\nkind: Deployment\nspec: {template: {spec: {containers: [{image: 'node:26'}]}}}",
      "notes/contract.yaml": "image: node:latest",
    };
    const generated = generateDependabotConfig({ files, policy });
    expect(check(generated, files)).toEqual([]);
    expect(generated).toContain("package-ecosystem: docker-compose");
    expect(generated).toContain("package-ecosystem: docker");
    for (const root of ["/nested", "/hidden", "/deploy"])
      expect(generated).toContain(root);
    expect(generated).not.toContain("/notes");
    expect(
      check(config(), files).some(({ message }) =>
        message.includes("docker-compose"),
      ),
    ).toBe(true);
    for (const name of [
      "app.Dockerfile",
      "dockerfile.dev",
      "APP.CONTAINERFILE",
    ]) {
      const manifests = { [`images/${name}`]: "FROM node:26" };
      const docker = generateDependabotConfig({ files: manifests, policy });
      expect(check(docker, manifests)).toEqual([]);
      expect(docker).toContain("package-ecosystem: docker");
    }
  });

  test("directory normalization preserves valid coverage without hiding traversal", () => {
    const files = { "app/package.json": "{}" };
    for (const directory of ["/app/", "/./app", "//app///", "/app"]) {
      expect(check(config([update("npm", directory)]), files)).toEqual([]);
      const list = {
        ...update(),
        directory: undefined,
        directories: [directory],
      };
      expect(check(config([list]), files)).toEqual([]);
      expect(
        check(
          config([update("npm", "/app"), update("npm", directory)]),
          files,
        ).some(({ message }) => message.includes("overlaps update entry")),
      ).toBe(true);
    }
    const invalid = check(config([update("npm", "/other/../app")]), files);
    expect(
      invalid.some(({ message }) =>
        message.includes("absolute repository paths"),
      ),
    ).toBe(true);
    expect(
      invalid.some(({ message }) => message.includes("covering /app")),
    ).toBe(true);
  });

  test("standard Python build and compile manifests derive update roots without reading arbitrary text files", () => {
    for (const name of [
      "requirements.in",
      "requirements_dev.in",
      "setup.py",
      "setup.cfg",
    ]) {
      for (const uv of [false, true]) {
        const files: Record<string, string> = { [`python/${name}`]: "" };
        if (uv) files["python/uv.lock"] = "";
        const ecosystem = uv && name.startsWith("requirements") ? "uv" : "pip";
        expect(
          check(config(), files).some(({ message }) =>
            message.includes(
              `add a ${ecosystem} update entry covering /python`,
            ),
          ),
        ).toBe(true);
        const generated = generateDependabotConfig({ files, policy });
        expect(check(generated, files)).toEqual([]);
        expect(generated).toContain(`package-ecosystem: ${ecosystem}`);
        expect(generated).toContain("/python");
      }
    }
    expect(
      checkDependabot({
        files: { "legal/contract.in": "", "legal/act.txt": "" },
        policy,
      }),
    ).toEqual([]);
  });

  test("update entries must claim distinct roots within each ecosystem", () => {
    const files = {
      "package.json": "{}",
      "packages/a/package.json": "{}",
      "packages/b/package.json": "{}",
      "pyproject.toml": "[project]\nname='example'",
    };
    const base = [
      update(),
      update("npm", "/packages/a"),
      update("npm", "/packages/b"),
      update("pip"),
    ];
    expect(check(config(base), files)).toEqual([]);
    for (const extra of [
      update(),
      update("npm", "/packages/a"),
      { ...update(), directory: undefined, directories: ["/packages/*"] },
      { ...update(), directory: undefined, directories: ["/**"] },
    ]) {
      const overlaps = check(config([...base, extra]), files).filter(
        ({ message }) => message.includes("overlaps update entry"),
      );
      expect(overlaps.length).toBeGreaterThan(0);
      expect(overlaps.every(({ line }) => line > 1)).toBe(true);
    }
    expect(
      check(
        config([
          ...base,
          update("npm", "/untracked"),
          update("npm", "/untracked/"),
        ]),
        files,
      ).some(
        ({ message }) =>
          message.includes("directory /untracked/ overlaps update entry") ||
          message.includes("directory /untracked overlaps update entry"),
      ),
    ).toBe(true);
    const grouped = {
      ...update(),
      directory: undefined,
      directories: ["/", "/packages/*", "/packages/a"],
    };
    expect(check(config([grouped, update("pip")]), files)).toEqual([]);
  });

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

  test("pnpm workspace YAML owns package membership and keeps exclusions and standalone roots", () => {
    const files = {
      "package.json": JSON.stringify({
        packageManager: "pnpm@10.0.0",
        workspaces: ["ignored/*"],
      }),
      "pnpm-workspace.yaml":
        'packages:\n  - ./packages//*\n  - "!./packages/excluded"',
      "packages/member/package.json": "{}",
      "packages/excluded/package.json": "{}",
      "independent/package.json": "{}",
      "ignored/member/package.json": "{}",
    };
    const good = config([
      update("npm"),
      update("npm", "/packages/excluded"),
      update("npm", "/independent"),
      update("npm", "/ignored/member"),
    ]);
    expect(check(good, files)).toEqual([]);
    const generated = generateDependabotConfig({ files, policy });
    expect(check(generated, files)).toEqual([]);
    expect(generated).not.toContain("/packages/member");
    for (const directory of [
      "/packages/excluded",
      "/independent",
      "/ignored/member",
    ])
      expect(generated).toContain(directory);
    const changed = {
      ...files,
      "pnpm-workspace.yaml": files["pnpm-workspace.yaml"].replace(
        "./packages//*",
        "other/*",
      ),
    };
    expect(changed["pnpm-workspace.yaml"]).not.toBe(
      files["pnpm-workspace.yaml"],
    );
    expect(
      check(good, changed).some(({ message }) =>
        message.includes("add a npm update entry covering /packages/member"),
      ),
    ).toBe(true);
    expect(
      check(generateDependabotConfig({ files: changed, policy }), changed),
    ).toEqual([]);
  });

  test("pnpm uses only the documented YAML filename and preserves root-only workspaces", () => {
    const files = {
      "package.json": JSON.stringify({
        packageManager: "pnpm@12.10.1",
        workspaces: ["packages/*"],
      }),
      "packages/member/package.json": "{}",
    };
    for (const { file, text } of [
      { file: "pnpm-workspace.yml", text: 'packages: ["packages/*"]' },
      { file: "pnpm-workspace.yaml", text: "catalog: {}" },
      { file: "pnpm-workspace.yaml", text: "packages: []\ncatalog: {}" },
    ]) {
      const entries = { ...files, [file]: text };
      expect(
        check(config(), entries).some(({ message }) =>
          message.includes("/packages/member"),
        ),
      ).toBe(true);
      const generated = generateDependabotConfig({ files: entries, policy });
      expect(check(generated, entries)).toEqual([]);
      expect(generated).toContain("/packages/member");
    }
    for (const text of ["[", "packages: wrong", "packages: [true]"])
      expect(() =>
        generateDependabotConfig({
          files: { ...files, "pnpm-workspace.yaml": text },
          policy,
        }),
      ).toThrow();
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

  test("infers GitHub Actions from root action metadata", () => {
    for (const file of ["action.yml", "action.yaml"]) {
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

  test("nested action metadata alone does not require an unsupported Dependabot update root", () => {
    for (const file of ["actions/composite/action.yml", "nested/action.yaml"]) {
      const files = {
        [file]: "name: Example\nruns:\n  using: composite\n  steps: []",
      };
      expect(checkDependabot({ files, policy })).toEqual([]);
      expect(generateDependabotConfig({ files, policy })).not.toContain(
        "github-actions",
      );
    }
  });

  test("Pipenv manifest and lock roots require pip entries even alongside uv markers", () => {
    for (const name of ["Pipfile", "Pipfile.lock"]) {
      const files = { [`python/${name}`]: "", "python/uv.lock": "" };
      const good = config([update("pip", "/python"), update("uv", "/python")]);
      expect(check(good, files)).toEqual([]);
      expect(
        check(config([update("uv", "/python")]), files).some(({ message }) =>
          message.includes("add a pip update entry covering /python"),
        ),
      ).toBe(true);
      expect(check(generateDependabotConfig({ files, policy }), files)).toEqual(
        [],
      );
    }
  });

  test("Docker and Containerfile suffix variants derive the same update root", () => {
    for (const name of [
      "Dockerfile",
      "Dockerfile.production",
      "Containerfile",
      "Containerfile.production",
    ]) {
      const files = { [`image/${name}`]: "FROM node:24.15.0" };
      expect(check(generateDependabotConfig({ files, policy }), files)).toEqual(
        [],
      );
      expect(
        check(config([]), files).some(({ message }) =>
          message.includes("add a docker update entry covering /image"),
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
