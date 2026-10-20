/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { parseDocument, stringify } from "yaml";

import {
  checkDependabot,
  declaredIgnoreConflicts,
  dependabotIgnoreUpdateTypes,
  generateDependabotConfig,
  parseDependabotIgnores,
  type DependabotIgnoreDeclaration,
} from "./toolchain-dependabot";
import { ownedDockerImageAliases } from "./toolchain-images";

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

const [major, minor, patch] = dependabotIgnoreUpdateTypes;
const files = {
  "package.json": JSON.stringify({ packageManager: "bun@1.4.3" }),
  "bun.lock": "",
  ".github/workflows/ci.yml": "jobs: {}",
  Dockerfile: "FROM node:24-alpine",
};
const declarations = [
  {
    ecosystem: "bun",
    dependency: "graphql",
    updateTypes: [major],
    reason: "Payload 3 requires graphql ^16.",
  },
  {
    ecosystem: "bun",
    dependency: "@babel/*",
    updateTypes: [major],
    reason: "Babel 8 changes the AST types the boundary check reads.",
  },
  {
    ecosystem: "bun",
    dependency: "@posthog/cli",
    updateTypes: [minor, major],
    reason: "0.x minors change the sourcemap upload CLI.",
  },
  {
    ecosystem: "github-actions",
    dependency: "stella/.github/.github/workflows/ai-shared-update.yml",
    updateTypes: [major, minor, patch],
    reason: "Newer commits no longer ship this reusable workflow.",
  },
];
const ignores = parseDependabotIgnores(declarations);

const permutations = <T>(items: readonly T[]): T[][] => {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
      (rest) => [item, ...rest],
    ),
  );
};

const generate = (declared: readonly DependabotIgnoreDeclaration[]) =>
  generateDependabotConfig({ files, policy, ignores: declared });
const check = (
  text: string,
  declared: readonly DependabotIgnoreDeclaration[] = ignores,
) =>
  checkDependabot({
    files: { ...files, ".github/dependabot.yml": text },
    policy,
    ignores: declared,
  });

const ignoresOf = (text: string, ecosystem: string) => {
  const parsed: unknown = parseDocument(text).toJS();
  if (typeof parsed !== "object" || parsed === null || !("updates" in parsed))
    throw new Error("generated Dependabot configuration has no updates");
  const { updates } = parsed;
  if (!Array.isArray(updates)) throw new Error("updates must be an array");
  const update: unknown = updates.find(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "package-ecosystem" in entry &&
      entry["package-ecosystem"] === ecosystem,
  );
  if (typeof update !== "object" || update === null || !("ignore" in update))
    return [];
  const { ignore } = update;
  if (!Array.isArray(ignore)) throw new Error("ignore must be an array");
  return ignore.map((entry: unknown) =>
    typeof entry === "object" && entry !== null && "dependency-name" in entry
      ? entry["dependency-name"]
      : undefined,
  );
};

const withIgnore = (
  text: string,
  ecosystem: string,
  change: (ignore: unknown[]) => unknown[],
) => {
  const document = parseDocument(text);
  const parsed: unknown = document.toJS();
  if (typeof parsed !== "object" || parsed === null || !("updates" in parsed))
    throw new Error("generated Dependabot configuration has no updates");
  const { updates } = parsed;
  if (!Array.isArray(updates)) throw new Error("updates must be an array");
  for (const update of updates) {
    if (
      typeof update !== "object" ||
      update === null ||
      !("package-ecosystem" in update) ||
      update["package-ecosystem"] !== ecosystem
    )
      continue;
    const ignore = "ignore" in update ? update.ignore : [];
    Object.assign(update, {
      ignore: change(Array.isArray(ignore) ? ignore : []),
    });
  }
  return stringify({ version: 2, updates });
};

describe("repository Dependabot ignores", () => {
  test("generate then check is a fixed point independent of declaration order", () => {
    const expected = generate(ignores);
    expect(check(expected)).toEqual([]);
    for (const order of permutations(declarations)) {
      const reordered = parseDependabotIgnores(
        order.map(({ ecosystem, dependency, updateTypes, reason }) => ({
          ecosystem,
          dependency,
          updateTypes: [...updateTypes].reverse(),
          reason,
        })),
      );
      expect(generate(reordered)).toBe(expected);
    }
    expect(
      generateDependabotConfig({
        files: Object.fromEntries(Object.entries(files).reverse()),
        policy,
        ignores,
      }),
    ).toBe(expected);
  });

  test("shared pins come first and declarations follow in code-unit order", () => {
    const generated = generate(ignores);
    expect(ignoresOf(generated, "bun")).toEqual([
      ...policy.ignoredPackages,
      "@babel/*",
      "@posthog/cli",
      "graphql",
    ]);
    expect(ignoresOf(generated, "github-actions")).toEqual([
      ...policy.ignoredActions,
      "stella/.github/.github/workflows/ai-shared-update.yml",
    ]);
    expect(ignoresOf(generated, "docker")).toEqual(
      ownedDockerImageAliases(policy.ignoredImages),
    );
    expect(generated).toContain(
      `dependency-name: "@posthog/cli"\n        update-types:\n          - ${major}\n          - ${minor}\n`,
    );
  });

  test("the checker accepts exactly the shared pins plus the declarations", () => {
    const generated = generate(ignores);
    for (const declaration of ignores) {
      const others = ignores.filter((entry) => entry !== declaration);
      expect(check(generated, others).length).toBeGreaterThan(0);
      expect(
        check(
          withIgnore(generated, declaration.ecosystem, (ignore) =>
            ignore.filter(
              (entry) =>
                typeof entry !== "object" ||
                entry === null ||
                !("dependency-name" in entry) ||
                entry["dependency-name"] !== declaration.dependency,
            ),
          ),
        ).some(({ message }) => message.includes(declaration.dependency)),
      ).toBe(true);
    }
    for (const name of ["*", "ox*", "unowned-package"])
      expect(
        check(
          withIgnore(generated, "bun", (ignore) => [
            ...ignore,
            {
              "dependency-name": name,
              "update-types": [...dependabotIgnoreUpdateTypes],
            },
          ]),
        ).some(({ message }) => message.includes("ignore only packages")),
      ).toBe(true);
  });

  test("declared ignores must keep their declared shape exactly once", () => {
    const generated = generate(ignores);
    const graphql = (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "dependency-name" in entry &&
      entry["dependency-name"] === "graphql";
    for (const mutate of [
      (entry: object) => ({ ...entry, "update-types": [major, minor] }),
      (entry: object) => ({ ...entry, versions: [">=17"] }),
      (entry: object) => ({ ...entry, "update-types": [] }),
      () => ({ "dependency-name": "graphql" }),
    ])
      expect(
        check(
          withIgnore(generated, "bun", (ignore) =>
            ignore.map((entry) =>
              graphql(entry) && typeof entry === "object" && entry !== null
                ? mutate(entry)
                : entry,
            ),
          ),
        ).some(({ message }) => message.includes("graphql exactly once")),
      ).toBe(true);
    expect(
      check(
        withIgnore(generated, "bun", (ignore) => [
          ...ignore,
          ...ignore.filter(graphql),
        ]),
      ).some(({ message }) => message.includes("graphql exactly once")),
    ).toBe(true);
  });

  test("declarations for ecosystems without an update entry fail", () => {
    const [first] = parseDependabotIgnores([
      { ...declarations[0], ecosystem: "cargo" },
    ]);
    if (first === undefined) throw new Error("expected one declaration");
    expect(() => generate([...ignores, first])).toThrow(
      "has no cargo update entry",
    );
    expect(
      check(generate(ignores), [...ignores, first]).some(({ message }) =>
        message.includes("has no cargo update entry"),
      ),
    ).toBe(true);
    expect(
      checkDependabot({ files: {}, policy, ignores: [first] }).length,
    ).toBeGreaterThan(0);
  });

  test("declarations never name or match a shared pin", () => {
    const sharedPins = [
      ...policy.ignoredPackages.flatMap((pin) => [
        { ecosystem: "bun", dependency: pin },
        { ecosystem: "npm", dependency: pin },
      ]),
      { ecosystem: "bun", dependency: "ox*" },
      { ecosystem: "bun", dependency: "@oxlint/*" },
      { ecosystem: "github-actions", dependency: "actions/*" },
      { ecosystem: "docker", dependency: "docker.io/library/*" },
      { ecosystem: "docker-compose", dependency: "*/node" },
    ];
    for (const shared of sharedPins) {
      const declared = parseDependabotIgnores([
        { ...shared, updateTypes: [major], reason: "Held." },
      ]);
      expect(
        declaredIgnoreConflicts({ ignores: declared, policy }),
      ).not.toEqual([]);
      expect(() => generate(declared)).toThrow("shared pin");
    }
    expect(declaredIgnoreConflicts({ ignores, policy })).toEqual([]);
  });

  test("the parser rejects every invalid declaration", () => {
    const valid = declarations[0];
    for (const input of [
      null,
      {},
      "graphql",
      [null],
      [{ ...valid, reason: "" }],
      [{ ...valid, reason: " \n" }],
      [{ ...valid, reason: undefined }],
      [{ ...valid, extra: true }],
      [{ ...valid, ecosystem: "yarn" }],
      [{ ...valid, ecosystem: undefined }],
      [{ ...valid, dependency: "" }],
      [{ ...valid, dependency: "*" }],
      [{ ...valid, dependency: "**" }],
      [{ ...valid, dependency: "graph ql" }],
      [{ ...valid, dependency: "graphql?" }],
      [{ ...valid, dependency: "[gG]raphql" }],
      [{ ...valid, dependency: "{a,b}" }],
      [{ ...valid, dependency: "!graphql" }],
      [{ ...valid, updateTypes: [] }],
      [{ ...valid, updateTypes: "version-update:semver-major" }],
      [{ ...valid, updateTypes: ["semver-major"] }],
      [{ ...valid, updateTypes: ["security-update:semver-major"] }],
      [{ ...valid, updateTypes: [major, major] }],
      [valid, valid],
      [valid, { ...valid, updateTypes: [minor], reason: "Other." }],
    ])
      expect(() => parseDependabotIgnores(input)).toThrow();
    expect(parseDependabotIgnores(undefined)).toEqual([]);
    expect(parseDependabotIgnores([])).toEqual([]);
    expect(
      parseDependabotIgnores([
        valid,
        { ...valid, ecosystem: "npm" },
        { ...valid, updateTypes: [patch, major], dependency: "graphql-*" },
      ]).map(({ updateTypes }) => updateTypes),
    ).toEqual([[major], [major], [major, patch]]);
  });
});
