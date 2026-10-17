# stella/stella source snapshot at d78d0b901f89bb3b979375dee5a7bdd29ce325d7

## .oxlint-plugins/drizzle.ts

````ts
import type { CreateOnceRule } from "@oxlint/plugins";
import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
} from "./utils.ts";

// Require a filter on the mutation's own fluent chain. An unrelated `.where`
// before the mutation or on an enclosing call cannot filter its rows. This
// checks configured receiver names; aliases and separately stored builders are
// outside the analysis boundary.
const receiverName = (node) => {
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "MemberExpression") {
    return getPropertyName(node.property);
  }
  if (node.type === "CallExpression") {
    return receiverName(node.callee);
  }
  return null;
};

const hasWhere = (node) => {
  let currentMember = node;
  let call = node.parent;
  while (call?.type === "CallExpression" && call.callee === currentMember) {
    const member = call.parent;
    if (member?.type !== "MemberExpression" || member.object !== call) {
      return false;
    }
    const nextCall = member.parent;
    if (nextCall?.type !== "CallExpression" || nextCall.callee !== member) {
      return false;
    }
    if (getPropertyName(member.property) === "where") {
      return true;
    }
    currentMember = member;
    call = nextCall;
  }
  return false;
};

const configuredReceiverNames = (option: unknown): string | string[] => {
  if (
    typeof option !== "object" ||
    option === null ||
    !("drizzleObjectName" in option)
  ) {
    return [];
  }
  const names = option.drizzleObjectName;
  if (typeof names === "string") {
    return names;
  }
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : [];
};

const rule = (mutation: "delete" | "update"): CreateOnceRule => ({
  meta: {
    type: "problem",
    messages: {
      missingWhere:
        mutation === "delete"
          ? "Without `.where(...)` you will delete all the rows in a table. If you didn't want to do it, please use `{{ drizzleObjName }}.delete(...).where(...)` instead. Otherwise you can ignore this rule here"
          : "Without `.where(...)` you will update all the rows in a table. If you didn't want to do it, please use `{{ drizzleObjName }}.update(...).set(...).where(...)` instead. Otherwise you can ignore this rule here",
    },
    schema: [
      {
        type: "object",
        properties: { drizzleObjectName: { type: ["string", "array"] } },
        additionalProperties: false,
      },
    ],
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (getPropertyName(node.property) !== mutation) {
          return;
        }
        if (
          node.parent.type !== "CallExpression" ||
          node.parent.callee !== node
        ) {
          return;
        }
        const names = configuredReceiverNames(context.options.at(0));
        const name = receiverName(node.object);
        if (
          typeof names === "string"
            ? name !== names
            : names.length > 0 && !names.includes(name)
        ) {
          return;
        }
        if (hasWhere(node)) {
          return;
        }
        const nextMember = node.parent.parent;
        const reportNode =
          mutation === "update" &&
          nextMember.type === "MemberExpression" &&
          getPropertyName(nextMember.property) === "set"
            ? nextMember
            : node;
        context.report({
          node: reportNode,
          messageId: "missingWhere",
          data: { drizzleObjName: name },
        });
      },
    };
  },
});

export default eslintCompatPlugin({
  meta: { name: "drizzle" },
  rules: {
    "no-direct-entity-reparent": {
      meta: {
        type: "problem",
        messages: {
          useMoveOwner:
            "Reparent existing entities through moveEntityHandler, which locks the matter before checking ancestry. Direct parentId updates bypass that invariant.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const filename = filenameForContext(context);
            if (
              filename.endsWith(".test.ts") ||
              filename.endsWith(".test.tsx") ||
              filename.includes("/apps/api/src/tests/") ||
              filename.endsWith("/apps/api/src/handlers/entities/move.ts")
            ) {
              return;
            }
            const callee = node.callee;
            if (
              callee.type !== "MemberExpression" ||
              getPropertyName(callee.property) !== "set"
            ) {
              return;
            }
            const update = callee.object;
            if (
              update.type !== "CallExpression" ||
              update.callee.type !== "MemberExpression" ||
              getPropertyName(update.callee.property) !== "update" ||
              !isIdentifier(update.arguments.at(0), "entities")
            ) {
              return;
            }
            const values = node.arguments.at(0);
            if (
              !isAstNode(values) ||
              values.type !== "ObjectExpression" ||
              !Array.isArray(values.properties)
            ) {
              return;
            }
            if (
              values.properties.some(
                (property) =>
                  isAstNode(property) &&
                  property.type === "Property" &&
                  getPropertyName(property.key) === "parentId",
              )
            ) {
              context.report({ node, messageId: "useMoveOwner" });
            }
          },
        };
      },
    },
    "enforce-delete-with-where": {
      ...rule("delete"),
    },
    "enforce-update-with-where": {
      ...rule("update"),
    },
  },
});
````

## .oxlint-plugins/__fixtures__/drizzle.fixture.ts

````ts
// Passive regression fixture for the mutation's own filter chain.
export type Mutation = {
  where: (filter: unknown) => Mutation;
  returning: () => Mutation;
  set: (values: unknown) => Mutation;
};
declare const db: {
  delete: (table: unknown) => Mutation;
  update: (table: unknown) => Mutation;
};
declare const tx: typeof db;
declare const unrelated: { where: () => void };
declare const wrap: (mutation: Mutation) => Mutation;
declare const table: unknown;
declare const filter: unknown;
declare const values: unknown;

// oxlint-disable-next-line drizzle/enforce-delete-with-where -- fixture rejects an unfiltered delete
db.delete(table);
// oxlint-disable-next-line drizzle/enforce-update-with-where -- fixture rejects an unfiltered update
tx.update(table).set(values);

// expect-clean: drizzle/enforce-delete-with-where
db.delete(table).where(filter);
// expect-clean: drizzle/enforce-update-with-where
tx.update(table).set(values).where(filter);

unrelated.where();
// oxlint-disable-next-line drizzle/enforce-delete-with-where -- preceding unrelated where must not hide a delete
db.delete(table);
unrelated.where();
// oxlint-disable-next-line drizzle/enforce-update-with-where -- preceding unrelated where must not hide an update
db.update(table).set(values);

// oxlint-disable-next-line drizzle/enforce-delete-with-where -- enclosing where cannot filter the nested delete
wrap(db.delete(table)).where(filter);
// oxlint-disable-next-line drizzle/enforce-update-with-where -- enclosing where cannot filter the nested update
wrap(db.update(table).set(values)).where(filter);

// expect-clean: drizzle/enforce-delete-with-where
db.delete(table).where(filter).returning();
// expect-clean: drizzle/enforce-update-with-where
db.update(table).set(values).where(filter).returning();

// Direct parent updates must stay in the move owner.
declare const entities: unknown;
declare const parentId: string | null;
// oxlint-disable-next-line drizzle/no-direct-entity-reparent -- fixture rejects reparenting outside its serialized owner
tx.update(entities).set({ parentId }).where(filter);
// expect-clean: drizzle/no-direct-entity-reparent
tx.update(entities).set({ name: "Folder" }).where(filter);
````

## .oxlint-plugins/__tests__/drizzle.test.ts

````ts
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { lintSingleRule } from "./lint-single-rule.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const PLUGIN_NAME = "drizzle";
const RULE_OPTIONS = { drizzleObjectName: ["db", "tx"] };

const lintRule = async (rule: string, source: string) =>
  await lintSingleRule(rule, `${source}\n`, {
    plugin: PLUGIN_NAME,
    ruleOptions: RULE_OPTIONS,
    sourcePath: "mutation.ts",
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

const lintDeleteAcrossFiles = async (sources: readonly string[]) => {
  const directory = await mkdtemp(path.join(tmpdir(), "stella-drizzle-where-"));
  try {
    const configPath = path.join(directory, "oxlint.config.ts");
    const jsPlugin = path.join(
      REPOSITORY_ROOT,
      ".oxlint-plugins",
      "drizzle.ts",
    );
    await Bun.write(
      configPath,
      `export default ${JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [jsPlugin],
        rules: {
          "drizzle/enforce-delete-with-where": ["error", RULE_OPTIONS],
        },
      })};\n`,
    );
    const sourcePaths = await Promise.all(
      sources.map(async (source, index) => {
        const sourcePath = path.join(directory, `source-${index}.ts`);
        await Bun.write(sourcePath, `${source}\n`);
        return sourcePath;
      }),
    );
    const spawned = Bun.spawn(
      [
        process.execPath,
        "--bun",
        "oxlint",
        "-c",
        configPath,
        "-f",
        "json",
        ...sourcePaths,
      ],
      { cwd: REPOSITORY_ROOT, stderr: "pipe", stdout: "pipe" },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(spawned.stdout).text(),
      new Response(spawned.stderr).text(),
      spawned.exited,
    ]);
    const report = Result.try((): unknown => JSON.parse(stdout));
    if (Result.isError(report)) {
      return panic(
        `oxlint did not produce valid JSON:\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    const diagnostics = isRecord(report.value)
      ? report.value.diagnostics
      : undefined;
    if (!isUnknownArray(diagnostics)) {
      return panic(
        `oxlint reported no diagnostics array:\n${stdout}\n${stderr}`,
      );
    }
    return diagnostics.filter(
      (diagnostic) =>
        isRecord(diagnostic) &&
        typeof diagnostic.code === "string" &&
        diagnostic.code.startsWith("drizzle(enforce-delete-with-where)"),
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

describe("Drizzle mutation where enforcement", () => {
  test("requires filters on delete and update while accepting filtered mutations", async () => {
    const deleteLines = await lintRule(
      "enforce-delete-with-where",
      ["db.delete(users);", "db.delete(users).where(eq(users.id, id));"].join(
        "\n",
      ),
    );
    const updateLines = await lintRule(
      "enforce-update-with-where",
      [
        "db.update(users).set({ name });",
        "db.update(users).set({ name }).where(eq(users.id, id));",
      ].join("\n"),
    );

    expect(deleteLines).toEqual([1]);
    expect(updateLines).toEqual([1]);
  });

  test("does not borrow an unrelated preceding where", async () => {
    const lines = await lintRule(
      "enforce-delete-with-where",
      ["db.select().where(eq(users.id, id));", "db.delete(users);"].join("\n"),
    );

    expect(lines).toEqual([2]);
  });

  test("does not borrow a where from an enclosing call", async () => {
    const deleteLines = await lintRule(
      "enforce-delete-with-where",
      "wrap(db.delete(users)).where(eq(users.id, id));",
    );
    const updateLines = await lintRule(
      "enforce-update-with-where",
      "wrap(db.update(users).set({ name })).where(eq(users.id, id));",
    );

    expect(deleteLines).toEqual([1]);
    expect(updateLines).toEqual([1]);
  });

  test("accepts returning after the mutation's own where", async () => {
    const deleteLines = await lintRule(
      "enforce-delete-with-where",
      "db.delete(users).where(eq(users.id, id)).returning();",
    );
    const updateLines = await lintRule(
      "enforce-update-with-where",
      "db.update(users).set({ name }).where(eq(users.id, id)).returning();",
    );

    expect(deleteLines).toEqual([]);
    expect(updateLines).toEqual([]);
  });

  test("keeps each file's filter state local within one oxlint run", async () => {
    const safeThenUnsafe = await lintDeleteAcrossFiles([
      "db.delete(users).where(eq(users.id, id));",
      "db.delete(users);",
    ]);
    const unsafeThenSafe = await lintDeleteAcrossFiles([
      "db.delete(users);",
      "db.delete(users).where(eq(users.id, id));",
    ]);

    expect(safeThenUnsafe).toHaveLength(1);
    expect(unsafeThenSafe).toHaveLength(1);
  });
});

describe("entity parent mutation ownership", () => {
  test("routes explicit parent updates to the serialized move owner", async () => {
    const source = [
      "tx.update(entities).set({ parentId }).where(filter);",
      "tx.update(entities).set({ name }).where(filter);",
      "tx.update(otherTable).set({ parentId }).where(filter);",
      "tx.update(entities).set({ ['parentId']: id }).where(filter);",
    ].join("\n");
    expect(
      await lintSingleRule("no-direct-entity-reparent", source, {
        plugin: PLUGIN_NAME,
        sourcePath: "apps/api/src/handlers/entities/other.ts",
      }),
    ).toEqual([1, 4]);
    expect(
      await lintSingleRule("no-direct-entity-reparent", source, {
        plugin: PLUGIN_NAME,
        sourcePath: "apps/api/src/handlers/entities/move.ts",
      }),
    ).toEqual([]);
  });
});
````

## .oxlint-plugins/no-crypto-random-uuid.ts

````ts
// Ban direct crypto.randomUUID() use in application code.
//
// UUID generation belongs behind the runtime's UUIDv7 owner so generated
// identifiers are time ordered and callers do not choose their own primitive.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { getImportedName, isAstNode, isIdentifier } from "./utils.ts";

const CRYPTO_MODULES = new Set(["crypto", "node:crypto"]);
const DIRECT_UUID_GENERATORS = new Set(["v4", "v7"]);

export default eslintCompatPlugin({
  meta: { name: "no-crypto-random-uuid" },
  rules: {
    "no-crypto-random-uuid": {
      meta: {
        type: "problem",
        messages: {
          noCryptoRandomUuid:
            "Do not use crypto.randomUUID() directly. " +
            "Use the runtime's UUIDv7 owner instead.",
          noCryptoRandomUuidImport:
            "Do not import randomUUID from '{{module}}'. " +
            "Use the UUID owner for this runtime instead.",
          noDirectUuidGeneratorImport:
            "Do not import {{generator}} directly from 'uuid'. " +
            "Use the UUID owner for this runtime instead.",
          noDirectUuidGeneratorCall:
            "Do not call {{generator}} from the 'uuid' module directly. " +
            "Use the UUID owner for this runtime instead.",
        },
      },
      createOnce(context) {
        const randomUuidAliases = new Set();
        const cryptoAliases = new Set(["crypto"]);
        const uuidModuleAliases = new Set<string>();

        return {
          before() {
            randomUuidAliases.clear();
            cryptoAliases.clear();
            cryptoAliases.add("crypto");
            uuidModuleAliases.clear();
          },
          ImportDeclaration(node) {
            if (typeof node.source.value !== "string") {
              return;
            }

            if (node.source.value === "uuid") {
              for (const specifier of node.specifiers) {
                if (
                  specifier.type === "ImportNamespaceSpecifier" ||
                  specifier.type === "ImportDefaultSpecifier"
                ) {
                  uuidModuleAliases.add(specifier.local.name);
                  continue;
                }
                const importedName = getImportedName(specifier);
                if (
                  importedName !== null &&
                  DIRECT_UUID_GENERATORS.has(importedName)
                ) {
                  context.report({
                    node: specifier,
                    messageId: "noDirectUuidGeneratorImport",
                    data: { generator: importedName },
                  });
                }
              }
              return;
            }

            if (!CRYPTO_MODULES.has(node.source.value)) {
              return;
            }

            for (const specifier of node.specifiers) {
              if (specifier.type === "ImportDefaultSpecifier") {
                cryptoAliases.add(specifier.local.name);
                continue;
              }

              if (specifier.type === "ImportNamespaceSpecifier") {
                cryptoAliases.add(specifier.local.name);
                continue;
              }

              if (getImportedName(specifier) === "randomUUID") {
                randomUuidAliases.add(specifier.local.name);
                context.report({
                  node: specifier,
                  messageId: "noCryptoRandomUuidImport",
                  data: { module: node.source.value },
                });
              }
            }
          },

          CallExpression(node) {
            const callee = node.callee;

            if (isIdentifier(callee) && randomUuidAliases.has(callee.name)) {
              context.report({
                node,
                messageId: "noCryptoRandomUuid",
              });
              return;
            }

            if (
              callee.type === "MemberExpression" &&
              !callee.computed &&
              isIdentifier(callee.object) &&
              uuidModuleAliases.has(callee.object.name) &&
              isIdentifier(callee.property) &&
              DIRECT_UUID_GENERATORS.has(callee.property.name)
            ) {
              context.report({
                node,
                messageId: "noDirectUuidGeneratorCall",
                data: { generator: callee.property.name },
              });
              return;
            }

            if (
              callee.type !== "MemberExpression" ||
              callee.computed ||
              !isIdentifier(callee.property, "randomUUID") ||
              !isCryptoObject(callee.object, cryptoAliases)
            ) {
              return;
            }

            context.report({
              node,
              messageId: "noCryptoRandomUuid",
            });
          },
        };
      },
    },
  },
});

const isCryptoObject = (node: unknown, cryptoAliases: Set<string>): boolean => {
  if (isIdentifier(node) && cryptoAliases.has(node.name)) {
    return true;
  }

  return (
    isAstNode(node) &&
    node.type === "MemberExpression" &&
    node.computed === false &&
    isIdentifier(node.object, "globalThis") &&
    isIdentifier(node.property, "crypto")
  );
};
````

## .oxlint-plugins/__fixtures__/no-crypto-random-uuid.fixture.ts

````ts
// Passive regression fixture for
// `no-crypto-random-uuid/no-crypto-random-uuid`.

// MUST flag: named crypto imports expose the wrong UUID version.
// oxlint-disable-next-line no-crypto-random-uuid/no-crypto-random-uuid -- fixture: randomUUID imports must use the runtime owner instead
import { randomUUID as makeRandomUuid } from "node:crypto";
// MUST flag: UUID package generators belong behind the runtime owner.
// oxlint-disable-next-line no-crypto-random-uuid/no-crypto-random-uuid -- x2 fixture: direct v4 and v7 imports must be rejected
import { v4, v7 as makeUuidV7 } from "uuid";

// MUST flag: imported aliases remain traceable at their call site.
// oxlint-disable-next-line no-crypto-random-uuid/no-crypto-random-uuid -- fixture: aliased randomUUID calls must be rejected
export const importedUuid = makeRandomUuid();

// MUST flag: the ambient crypto namespace is protected too.
// oxlint-disable-next-line no-crypto-random-uuid/no-crypto-random-uuid -- fixture: ambient crypto.randomUUID must be rejected
export const browserStyleUuid = crypto.randomUUID();

// MUST flag: an explicit globalThis receiver cannot bypass the owner.
// oxlint-disable-next-line no-crypto-random-uuid/no-crypto-random-uuid -- fixture: globalThis crypto calls must use the runtime UUIDv7 owner
export const globalBrowserStyleUuid = globalThis.crypto.randomUUID();

export const directV4Uuid = v4();
export const directV7Uuid = makeUuidV7();

// Allowed: Bun's time-ordered UUID generator is the sanctioned primitive.
// expect-clean: no-crypto-random-uuid/no-crypto-random-uuid
export const orderedUuid = Bun.randomUUIDv7();

// Allowed: application code uses the web owner for identifiers and nonces.
// expect-clean: no-crypto-random-uuid/no-crypto-random-uuid
export { createRandomValue, createUuid } from "../../apps/web/src/lib/uuid";
````

## .oxlint-plugins/__tests__/no-crypto-random-uuid.test.ts

````ts
import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects ambient crypto UUIDs and direct UUID package generators", async () => {
  expect(
    await lintSingleRule(
      "no-crypto-random-uuid",
      [
        'import { randomUUID as makeId } from "node:crypto";',
        "makeId();",
        "crypto.randomUUID();",
        "globalThis.crypto.randomUUID();",
        'import * as nodeCrypto from "node:crypto";',
        "nodeCrypto.randomUUID();",
        'import defaultCrypto from "crypto";',
        "defaultCrypto.randomUUID();",
        'import { randomUUID } from "crypto";',
        "randomUUID();",
        'import { v4, v7 as makeV7, v5 } from "uuid";',
        "v4(); makeV7(); v5();",
        'import * as uuid from "uuid";',
        "uuid.v4(); uuid.v7(); uuid.validate(value);",
        'import uuidDefault from "uuid";',
        "uuidDefault.v7();",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4, 6, 8, 9, 10, 11, 11, 14, 14, 16]);
});

test("allows ordered Bun identifiers and unrelated random UUID methods", async () => {
  expect(
    await lintSingleRule(
      "no-crypto-random-uuid",
      [
        "Bun.randomUUIDv7();",
        "crypto.getRandomValues(new Uint8Array(8));",
        'import { randomBytes } from "node:crypto";',
        "randomBytes(8);",
        'const local = { randomUUID: () => "local" };',
        "local.randomUUID();",
        'import { createRandomValue, createUuid } from "@/lib/uuid";',
        "createUuid(); createRandomValue();",
      ].join("\n"),
    ),
  ).toEqual([]);
});
````

## .oxlint-plugins/no-nanoid.ts

````ts
// Entry point that keeps the `no-nanoid/no-nanoid` rule id; the table row and
// the detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "no-nanoid" },
  rules: {
    "no-nanoid": {
      meta: restrictedImportMeta("no-nanoid"),
      createOnce(context) {
        return restrictedImportVisitors(context, "no-nanoid");
      },
    },
  },
});
````

## .oxlint-plugins/__fixtures__/no-nanoid.fixture.ts

````ts
/* oxlint-disable import/no-duplicates, unicorn/prefer-module -- fixture: each import form stands on its own line */

// Passive regression fixture for `no-nanoid/no-nanoid`: every load of the
// removed dependency is reported once, however it is written.

// oxlint-disable-next-line no-nanoid/no-nanoid -- side-effect import
import "nanoid";
// oxlint-disable-next-line no-nanoid/no-nanoid -- aliased named import
import { nanoid as makeId } from "nanoid";
// oxlint-disable-next-line no-nanoid/no-nanoid -- type-only import still names the removed package
import type { nanoid as NanoidFn } from "nanoid";
// oxlint-disable-next-line no-nanoid/no-nanoid -- namespace import
import * as Nanoid from "nanoid";
// oxlint-disable-next-line no-nanoid/no-nanoid -- subpath import
import { customAlphabet } from "nanoid/non-secure";
// expect-clean: no-nanoid/no-nanoid
import { randomUUID } from "node:crypto";

// oxlint-disable-next-line no-nanoid/no-nanoid -- require
const requiredModule = require("nanoid");
// oxlint-disable-next-line no-nanoid/no-nanoid -- require member
const requiredMember = require("nanoid").nanoid;
// oxlint-disable-next-line no-nanoid/no-nanoid -- awaited dynamic import with destructuring
const { nanoid: loadedNanoid } = await import("nanoid");
// oxlint-disable-next-line no-nanoid/no-nanoid -- dynamic import
const pendingModule = import("nanoid/async");

// oxlint-disable-next-line no-nanoid/no-nanoid -- named re-export
export { nanoid as reexportedNanoid } from "nanoid";
// oxlint-disable-next-line no-nanoid/no-nanoid -- star re-export
export * from "nanoid/non-secure";

// expect-clean: no-nanoid/no-nanoid
const generatedId = Bun.randomUUIDv7();
const randomBytes = crypto.getRandomValues(new Uint8Array(16));
const typedId: ReturnType<typeof NanoidFn> = makeId();

export {
  customAlphabet,
  generatedId,
  loadedNanoid,
  Nanoid,
  pendingModule,
  randomBytes,
  randomUUID,
  requiredMember,
  requiredModule,
  typedId,
};
````

## .oxlint-plugins/__tests__/no-nanoid.test.ts

````ts
import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects every load of the removed package including types and subpaths", async () => {
  expect(
    await lintSingleRule(
      "no-nanoid",
      'import "nanoid";\nimport { nanoid as makeId } from "nanoid";\nimport type { nanoid } from "nanoid";\nconst module = require("nanoid/non-secure");\nconst pending = import("nanoid/async");\nexport * from "nanoid";',
    ),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("allows platform identifiers and unrelated package names", async () => {
  expect(
    await lintSingleRule(
      "no-nanoid",
      'import { randomUUID } from "node:crypto";\nconst id = Bun.randomUUIDv7();\nconst bytes = crypto.getRandomValues(new Uint8Array(8));\nimport "nanoid-like";',
    ),
  ).toEqual([]);
});

test("recognizes an imported module loader", async () => {
  expect(
    await lintSingleRule(
      "no-nanoid",
      [
        'import { createRequire } from "node:module";',
        "const loadModule = createRequire(import.meta.url);",
        'loadModule("node:fs");',
        'loadModule("nanoid");',
      ].join("\n"),
    ),
  ).toEqual([4]);
});
````

## .oxlint-plugins/no-detached-void.ts

````ts
// Forbid the `void` operator.
//
// A bare `void promise` detaches a promise so `no-floating-promises` stops
// complaining, but it also throws the rejection away: an async failure
// becomes an unhandled-rejection event instead of structured telemetry.
// Route fire-and-forget work through the `detached(promise, context)` helper
// (`@/lib/detached` on the web, `@/api/lib/analytics/capture` on the API) so every
// rejection reaches the shared error-capture channel with a stable context
// tag.
//
// This bans the value-level `void` UNARY operator only; the `void` TYPE
// keyword (`: void`, `Promise<void>`, `() => void`) is a different AST node
// and is untouched.
//
// Flags:
//   void somePromise();                 // -> detached(somePromise(), "ctx")
//   void (async () => { ... })();       // -> detached((async () => {...})(), "ctx")
//   onClick={() => void save()}         // -> onClick={() => detached(save(), "ctx")}
//
// For the rare non-promise `void` (forcing reflow, marking a value used,
// exhaustiveness), restructure instead of detaching: drop the operator on a
// synchronous call statement, use `x satisfies never` for an exhaustive
// switch default, or `() => undefined` for a deliberate no-op.

import { eslintCompatPlugin } from "@oxlint/plugins";

export default eslintCompatPlugin({
  meta: { name: "no-detached-void" },
  rules: {
    "no-detached-void": {
      meta: {
        type: "problem",
        messages: {
          noVoidOperator:
            "Do not use the `void` operator. For fire-and-forget promises " +
            "use `detached(promise, context)` so the rejection is captured; " +
            "for a synchronous expression, restructure to avoid `void` " +
            "(drop it on a call statement, use `x satisfies never` for an " +
            "exhaustive default, or `() => undefined` for a no-op).",
        },
      },
      createOnce(context) {
        return {
          UnaryExpression(node) {
            if (node.operator !== "void") {
              return;
            }
            context.report({
              node,
              messageId: "noVoidOperator",
            });
          },
        };
      },
    },
  },
});
````

## .oxlint-plugins/__fixtures__/no-detached-void.fixture.ts

````ts
// Passive regression fixture for `no-detached-void/no-detached-void`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// allowed cases carry no disable, so a false positive would fail the fixture
// too.

declare const somePromise: () => Promise<void>;
declare const save: () => Promise<void>;

// MUST flag: void of a promise-returning call.
export const detachCall = () => {
  // oxlint-disable-next-line no-detached-void/no-detached-void
  void somePromise();
};

// MUST flag: void of an async IIFE.
export const detachIife = () => {
  // oxlint-disable-next-line no-detached-void/no-detached-void
  void (async () => {
    await save();
  })();
};

// MUST flag: void of a literal (the operator is banned regardless of operand).
export const voidLiteral = () => {
  // oxlint-disable-next-line no-detached-void/no-detached-void
  void 0;
};

// Allowed — the `void` TYPE keyword is a different AST node and must not be
// flagged. A false positive here (no disable present) would fail the fixture.
// expect-clean: no-detached-void/no-detached-void
export const returnsVoid: () => void = () => undefined;
export const awaitsVoid = async (): Promise<void> => {
  await save();
};
export type VoidReturning = (value: string) => void;
````

## .oxlint-plugins/__tests__/no-detached-void.test.ts

````ts
import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects detached promises and async IIFEs", async () => {
  expect(
    await lintSingleRule(
      "no-detached-void",
      "void save();\nvoid (async () => { await save(); })();",
    ),
  ).toEqual([1, 2]);
});

test("rejects void in an event callback", async () => {
  expect(
    await lintSingleRule(
      "no-detached-void",
      "const button = <button onClick={() => void save()} />;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1]);
});

test("rejects synchronous value-level void", async () => {
  expect(
    await lintSingleRule("no-detached-void", "void element.offsetHeight;"),
  ).toEqual([1]);
});

test("accepts captured background failures and awaited work", async () => {
  expect(
    await lintSingleRule(
      "no-detached-void",
      'detached(save(), "save");\nasync function submit() { await save(); }',
    ),
  ).toEqual([]);
});

test("accepts void type annotations and deliberate no-op callbacks", async () => {
  expect(
    await lintSingleRule(
      "no-detached-void",
      "function notify(): void {}\nconst callback: () => void = () => undefined;\nconst pending: Promise<void> = notifyAsync();",
    ),
  ).toEqual([]);
});
````

## .oxlint-plugins/restricted-import.ts

````ts
// One table and one detector for "this import belongs to one owner module".
//
// Each row names the module(s), the exports it restricts (or the whole
// module), the owner files where the import is allowed, and the message
// pointing at the owner. The plugin files named after each rule
// (`no-nanoid.ts`, `no-raw-use-effect.ts`, ...) are thin entry points that
// keep the rule ids stable; the policy lives here.
//
// A restricted export is recognised however it is reached: a named import
// (aliased or not), a namespace or default import read as `ns.X`, `ns["X"]`
// or `<ns.X />`, `const { X } = ns`, `require("m").X`, `(await import("m")).X`,
// `const { X } = await import("m")`, and re-exports (`export { X } from "m"`,
// `export * from "m"`).

import type {
  Context,
  ESTree,
  Ranged,
  Scope,
  Variable,
  VisitorWithHooks,
} from "@oxlint/plugins";

import {
  type AstNode,
  canonicalModuleId,
  dynamicModuleSourceForEnforcement,
  getImportedName,
  getPropertyName,
  invokedCallee,
  isAstNode,
  isFileIn,
  isIdentifier,
  isIdentifierReference,
  isSingleAssignment,
  isStringLiteral,
  memberPropertyName,
  type ModuleMatcher,
  moduleMatches,
  NAMESPACE_IMPORT,
  patternKeyFor,
  repoRelativeFilename,
  type ResolvedImport,
  unwrapExpression,
} from "./utils.ts";

// --- Table ------------------------------------------------------------------

// Whether an `import type` / `export type` of the module still counts.
const TYPE_ONLY_IMPORTS = {
  allowed: "allowed",
  restricted: "restricted",
} as const;
type TypeOnlyImports =
  (typeof TYPE_ONLY_IMPORTS)[keyof typeof TYPE_ONLY_IMPORTS];

// Whether `import("m")` counts: a lazy boundary is the sanctioned shape for
// some modules, so only their static imports are restricted.
const DYNAMIC_IMPORTS = {
  allowed: "allowed",
  restricted: "restricted",
} as const;
type DynamicImports = (typeof DYNAMIC_IMPORTS)[keyof typeof DYNAMIC_IMPORTS];

// Where a restricted export is reported: at the binding that brings it into
// scope, or at each call of it (so a suppression names one call site).
const EXPORT_HIT = { binding: "binding", call: "call" } as const;
type ExportHit = (typeof EXPORT_HIT)[keyof typeof EXPORT_HIT];

type Restriction =
  | {
      type: "module";
      typeOnlyImports: TypeOnlyImports;
      dynamicImports: DynamicImports;
    }
  | { type: "exports"; names: ReadonlySet<string>; hit: ExportHit };

type RestrictedImportEntry = {
  messageId: string;
  message: string;
  modules: readonly ModuleMatcher[];
  restriction: Restriction;
  // Repository paths (or path suffixes) where the import is allowed.
  owners: readonly string[];
};

// A bare package and every subpath of it (`nanoid`, `nanoid/non-secure`).
const packageWithSubpaths =
  (name: string) =>
  (moduleId: string): boolean =>
    moduleId === name || moduleId.startsWith(`${name}/`);

// lucide exports every glyph as `X`, `XIcon` and `LucideX`.
const lucideGlyphNames = (glyphs: readonly string[]): ReadonlySet<string> =>
  new Set(glyphs.flatMap((glyph) => [glyph, `${glyph}Icon`, `Lucide${glyph}`]));

// Test support (`asTestRaw` and the other unchecked casts) must not be
// reachable from production modules.
const isTestSupportModule = (moduleId: string): boolean =>
  moduleId.startsWith("apps/api/src/tests/");

const LUCIDE = packageWithSubpaths("lucide-react");
// Every icon reaches the app through one module, so a glyph restricted to an
// owner component is restricted there too.
const ICON_MODULE = "packages/ui/src/icons.ts";
const ICON_SOURCES = [
  LUCIDE,
  "@stll/ui/icons",
  ICON_MODULE.replace(/\.ts$/u, ""),
] as const;
const TANSTACK_DEVTOOLS_ROOT =
  "apps/web/src/components/tanstack-devtools-root.tsx";
const TABLE_DEVTOOLS =
  "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table/table-devtools.tsx";
const TANSTACK_START_SERVER = "@tanstack/react-start/server";

const STATIC_DEVTOOLS_PACKAGE_MESSAGE =
  "Keep TanStack devtools package imports inside the approved lazy-loaded devtools modules.";

const staticDevtoolsPackage = (
  packages: readonly string[],
  owners: readonly string[],
): RestrictedImportEntry => ({
  messageId: "staticDevtoolsPackage",
  message: STATIC_DEVTOOLS_PACKAGE_MESSAGE,
  modules: packages,
  restriction: {
    type: "module",
    typeOnlyImports: TYPE_ONLY_IMPORTS.allowed,
    dynamicImports: DYNAMIC_IMPORTS.allowed,
  },
  owners,
});

const RESTRICTED_IMPORT_RULES = {
  // One icon module decides what each glyph means (a skill, an AI action),
  // so a call site cannot pick a lucide glyph that means something else
  // elsewhere. See packages/ui/src/icons.ts for how to add one.
  "no-direct-lucide-import": [
    {
      messageId: "directLucideImport",
      message:
        "Import icons from '@stll/ui/icons' (packages/ui/src/icons.ts); " +
        "add a new icon there with a one-line reason.",
      modules: [LUCIDE],
      restriction: {
        type: "module",
        typeOnlyImports: TYPE_ONLY_IMPORTS.restricted,
        dynamicImports: DYNAMIC_IMPORTS.restricted,
      },
      // The module, and its drift test, which compares entries against lucide.
      owners: [ICON_MODULE, "packages/ui/src/icons.test.ts"],
    },
  ],
  // Production API modules import nothing under apps/api/src/tests/; the
  // scope (production versus test files) is set by the rule's override in
  // oxlint.config.ts.
  "no-test-support-import": [
    {
      messageId: "noTestSupportImport",
      message:
        "Production modules must not import from apps/api/src/tests/. " +
        "Move test-only code under that directory and import it only from " +
        "tests.",
      modules: [isTestSupportModule],
      restriction: {
        type: "module",
        typeOnlyImports: TYPE_ONLY_IMPORTS.restricted,
        dynamicImports: DYNAMIC_IMPORTS.restricted,
      },
      owners: [],
    },
  ],
  // nanoid is a removed dependency: IDs come from Bun.randomUUIDv7() and
  // custom alphabets from crypto.getRandomValues().
  "no-nanoid": [
    {
      messageId: "noNanoid",
      message:
        "Do not import nanoid. Use Bun.randomUUIDv7() for IDs or " +
        "crypto.getRandomValues() for custom alphabets.",
      modules: [packageWithSubpaths("nanoid")],
      restriction: {
        type: "module",
        typeOnlyImports: TYPE_ONLY_IMPORTS.restricted,
        dynamicImports: DYNAMIC_IMPORTS.restricted,
      },
      owners: [],
    },
  ],
  // Route code has one approved helper; other exports stay at the boundary.
  "confine-server-reads": [
    {
      messageId: "confineServerReads",
      message: "Use the approved server request helper for this access.",
      modules: [TANSTACK_START_SERVER],
      restriction: {
        type: "exports",
        names: new Set([
          "getCookie",
          "getCookies",
          "getRequest",
          "getRequestHeader",
          "getRequestHeaders",
        ]),
        hit: EXPORT_HIT.binding,
      },
      owners: [],
    },
  ],
  // `<MatterIcon>` always resolves a matter colour (or paints the deliberate
  // neutral variant), so the raw layers glyph is drawn only there.
  "no-direct-matter-glyph": [
    {
      messageId: "directMatterGlyph",
      message:
        "Do not import '{{name}}' from 'lucide-react' here. Render " +
        "<MatterIcon> from '@stll/ui/matter-icon' instead so the " +
        "matter colour is always applied (matter={{ id, color }}, or " +
        'variant="none" / variant="all" for non-matter affordances). ' +
        "The raw glyph is only allowed in matter-icon.tsx.",
      modules: ICON_SOURCES,
      restriction: {
        type: "exports",
        names: lucideGlyphNames(["Layers", "Layers2"]),
        hit: EXPORT_HIT.binding,
      },
      owners: ["packages/ui/src/components/matter-icon.tsx", ICON_MODULE],
    },
  ],
  // `<EntityKindIcon>` switches exhaustively over the entity kind. Only the
  // folder and task glyphs are restricted: they name a kind wherever they
  // appear, while file/mail/link glyphs carry ordinary non-entity meanings.
  // The `entity-kind-glyph-adhoc` ratchet metric covers the rest.
  "no-direct-entity-glyph": [
    {
      messageId: "directEntityGlyph",
      message:
        "Do not import '{{name}}' from 'lucide-react' here. Render " +
        '<EntityKindIcon kind="folder" | "task"> from ' +
        "'@/components/workspaces/entity-kind-icon' instead (pass " +
        'folderState="expanded" for an open folder), so every entity ' +
        "glyph comes from one exhaustive kind mapping. Use <EntityIcon> " +
        "when the entity is still resolving.",
      modules: ICON_SOURCES,
      restriction: {
        type: "exports",
        names: lucideGlyphNames(["Folder", "FolderOpen", "ListTodo"]),
        hit: EXPORT_HIT.binding,
      },
      owners: [
        "apps/web/src/components/workspaces/entity-kind-icon.tsx",
        ICON_MODULE,
      ],
    },
  ],
  // Devtools packages can schedule browser work while routes are still
  // mounting, so they load only inside lazy islands, and the islands
  // themselves are reached only through `import()`.
  "no-static-devtools-import": [
    staticDevtoolsPackage(
      [
        "@tanstack/react-devtools",
        "@tanstack/react-query-devtools",
        "@tanstack/react-router-devtools",
      ],
      [TANSTACK_DEVTOOLS_ROOT],
    ),
    staticDevtoolsPackage(
      ["@tanstack/react-table-devtools"],
      [TANSTACK_DEVTOOLS_ROOT, TABLE_DEVTOOLS],
    ),
    {
      messageId: "staticDevtoolsModule",
      message:
        "Keep devtools modules behind a dynamic import so route shells can " +
        "mount before devtools code loads.",
      modules: [
        "apps/web/src/components/tanstack-devtools-root",
        "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table/table-devtools",
      ],
      restriction: {
        type: "module",
        typeOnlyImports: TYPE_ONLY_IMPORTS.allowed,
        dynamicImports: DYNAMIC_IMPORTS.allowed,
      },
      owners: [],
    },
  ],
  // Most effects are unnecessary; external-system sync goes through the
  // named wrappers so intent is explicit. See /conventions-use-effect.
  "no-raw-use-effect": [
    {
      messageId: "noRawUseEffect",
      message:
        "Direct useEffect is banned. Most effects are unnecessary: derive " +
        "state in render, do the work in the event handler, fetch with " +
        "TanStack Query, or reset with `key`. For genuine external-system " +
        "sync use useMountEffect or useExternalSyncEffect from " +
        "@/hooks/use-effect. See the convention: /conventions-use-effect.",
      modules: [packageWithSubpaths("react")],
      restriction: {
        type: "exports",
        names: new Set(["useEffect"]),
        hit: EXPORT_HIT.call,
      },
      owners: ["apps/web/src/hooks/use-effect.ts"],
    },
  ],
} as const satisfies Record<string, readonly RestrictedImportEntry[]>;

export type RestrictedImportRuleName = keyof typeof RESTRICTED_IMPORT_RULES;

// --- Resolution -------------------------------------------------------------

// A default import is read as the namespace too: `import React from "react"`
// then `React.useEffect` reaches the same export as `import * as React`.
const isNamespaceLike = (binding: ResolvedImport): boolean =>
  binding.imported === NAMESPACE_IMPORT || binding.imported === "default";

const canonical = (context: Context, source: string): string =>
  canonicalModuleId(source, repoRelativeFilename(context));

// The variable `name` binds at `node`, walking the scope chain outwards.
// Takes a name rather than an identifier so JSX names resolve too.
const variableAt = (
  context: Context,
  node: ESTree.Node,
  name: string,
): Variable | null => {
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
};

const exportOfVariable = (
  context: Context,
  variable: Variable,
  seen: Set<unknown>,
): ResolvedImport | null => {
  const definition = variable.defs.at(0);
  if (variable.defs.length !== 1 || definition === undefined) {
    return null;
  }
  const node: unknown = definition.node;
  if (definition.type === "ImportBinding") {
    const declaration: unknown = definition.parent;
    if (
      !isAstNode(node) ||
      node.importKind === "type" ||
      !isAstNode(declaration) ||
      declaration.importKind === "type" ||
      !isStringLiteral(declaration.source)
    ) {
      return null;
    }
    const moduleId = canonical(context, declaration.source.value);
    if (node.type === "ImportNamespaceSpecifier") {
      return { moduleId, imported: NAMESPACE_IMPORT };
    }
    if (node.type === "ImportDefaultSpecifier") {
      return { moduleId, imported: "default" };
    }
    const imported = getImportedName(node);
    return imported === null ? null : { moduleId, imported };
  }
  if (
    definition.type !== "Variable" ||
    !isAstNode(node) ||
    node.type !== "VariableDeclarator" ||
    !isSingleAssignment(variable)
  ) {
    return null;
  }
  const init = exportOfExpression(context, node.init, seen);
  if (init === null || isIdentifier(node.id)) {
    return init;
  }
  if (!isAstNode(node.id) || node.id.type !== "ObjectPattern") {
    return null;
  }
  const key = patternKeyFor(node.id, definition.name);
  return isNamespaceLike(init) && key !== null
    ? { moduleId: init.moduleId, imported: key }
    : null;
};

// The module export an expression evaluates to: an imported binding, a
// member of a namespace (static, dynamic or required), or an alias of
// either. Null for locals, parameters and call results.
const exportOfExpression = (
  context: Context,
  node: unknown,
  seen = new Set<unknown>(),
): ResolvedImport | null => {
  const expression = unwrapExpression(node);
  if (!isAstNode(expression) || seen.has(expression)) {
    return null;
  }
  seen.add(expression);
  const loaded = dynamicModuleSourceForEnforcement(expression, context);
  if (loaded !== null) {
    return { moduleId: canonical(context, loaded), imported: NAMESPACE_IMPORT };
  }
  if (isIdentifierReference(expression)) {
    const variable = variableAt(context, expression, expression.name);
    return variable === null ? null : exportOfVariable(context, variable, seen);
  }
  if (expression.type !== "MemberExpression") {
    return null;
  }
  const base = exportOfExpression(context, expression.object, seen);
  const property = memberPropertyName(expression);
  return base !== null && property !== null && isNamespaceLike(base)
    ? { moduleId: base.moduleId, imported: property }
    : null;
};

// `<ns.X />`: the JSX object is a JSXIdentifier, which scope lookup takes by
// name.
const exportOfJsxMember = (
  context: Context,
  node: ESTree.JSXMemberExpression,
): ResolvedImport | null => {
  const { object, property } = node;
  if (object.type !== "JSXIdentifier") {
    return null;
  }
  const variable = variableAt(context, node, object.name);
  const base =
    variable === null ? null : exportOfVariable(context, variable, new Set());
  return base !== null && isNamespaceLike(base)
    ? { moduleId: base.moduleId, imported: property.name }
    : null;
};

// --- Detection --------------------------------------------------------------

// `require("m")` loads eagerly like a static import; `import("m")` is the
// lazy boundary some rows allow.
const MODULE_LOADING = { static: "static", dynamic: "dynamic" } as const;
type ModuleLoading = (typeof MODULE_LOADING)[keyof typeof MODULE_LOADING];

const moduleIn = (entry: RestrictedImportEntry, moduleId: string): boolean =>
  entry.modules.some((matcher) => moduleMatches(matcher, moduleId));

const isTypeOnlyDeclaration = (node: AstNode): boolean => {
  const kind = node.importKind ?? node.exportKind;
  if (kind === "type") {
    return true;
  }
  if (!Array.isArray(node.specifiers) || node.specifiers.length === 0) {
    return false;
  }
  return node.specifiers.every(
    (specifier: unknown) =>
      isAstNode(specifier) &&
      (specifier.importKind === "type" || specifier.exportKind === "type"),
  );
};

const isTypeOnlySpecifier = (specifier: AstNode): boolean =>
  specifier.importKind === "type" || specifier.exportKind === "type";

// The export a specifier of `export { X as Y } from "m"` reads.
const reexportedName = (specifier: AstNode): string | null =>
  getPropertyName(specifier.local);

export const restrictedImportMeta = (ruleName: RestrictedImportRuleName) => ({
  type: "problem" as const,
  messages: Object.fromEntries(
    RESTRICTED_IMPORT_RULES[ruleName].map((entry) => [
      entry.messageId,
      entry.message,
    ]),
  ),
});

export const restrictedImportVisitors = (
  context: Context,
  ruleName: RestrictedImportRuleName,
): VisitorWithHooks => {
  const entries: readonly RestrictedImportEntry[] =
    RESTRICTED_IMPORT_RULES[ruleName];
  let active: RestrictedImportEntry[] = [];

  const report = (
    node: Ranged,
    entry: RestrictedImportEntry,
    name: string,
  ): void => {
    context.report({ node, messageId: entry.messageId, data: { name } });
  };

  // Every entry the resolved export falls under, for the given hit site.
  const reportExport = (
    node: Ranged,
    resolved: ResolvedImport | null,
    hit: ExportHit,
  ): void => {
    if (resolved === null) {
      return;
    }
    for (const entry of active) {
      const { restriction } = entry;
      if (
        restriction.type === "exports" &&
        restriction.hit === hit &&
        restriction.names.has(resolved.imported) &&
        moduleIn(entry, resolved.moduleId)
      ) {
        report(node, entry, resolved.imported);
      }
    }
  };

  // Static import, re-export, `require`, or `import()` of a module entry.
  const reportModuleLoad = (
    node: Ranged,
    source: string,
    loading: ModuleLoading,
  ): void => {
    const moduleId = canonical(context, source);
    for (const entry of active) {
      const { restriction } = entry;
      if (
        restriction.type === "module" &&
        moduleIn(entry, moduleId) &&
        (loading === MODULE_LOADING.static ||
          restriction.dynamicImports === DYNAMIC_IMPORTS.restricted)
      ) {
        report(node, entry, moduleId);
      }
    }
  };

  const exportEntriesFor = (source: string): RestrictedImportEntry[] => {
    const moduleId = canonical(context, source);
    return active.filter(
      (entry) =>
        entry.restriction.type === "exports" && moduleIn(entry, moduleId),
    );
  };

  const moduleLoadAllowsTypes = (source: string): boolean => {
    const moduleId = canonical(context, source);
    return active.every(
      (entry) =>
        entry.restriction.type !== "module" ||
        !moduleIn(entry, moduleId) ||
        entry.restriction.typeOnlyImports === TYPE_ONLY_IMPORTS.allowed,
    );
  };

  // `import`/`export ... from "m"`: the module entries, then the named
  // exports bound or re-exported by name.
  const checkDeclaration = (
    node: unknown,
    specifierName: (specifier: AstNode) => string | null,
  ): void => {
    if (!isAstNode(node) || !isStringLiteral(node.source)) {
      return;
    }
    const source = node.source.value;
    const typeOnly = isTypeOnlyDeclaration(node);
    if (!typeOnly || !moduleLoadAllowsTypes(source)) {
      reportModuleLoad(node, source, MODULE_LOADING.static);
    }
    if (typeOnly || !Array.isArray(node.specifiers)) {
      return;
    }
    const exportEntries = exportEntriesFor(source);
    for (const specifier of node.specifiers) {
      if (!isAstNode(specifier) || isTypeOnlySpecifier(specifier)) {
        continue;
      }
      const name = specifierName(specifier);
      for (const entry of exportEntries) {
        const { restriction } = entry;
        const bindsHere =
          restriction.type === "exports" &&
          (restriction.hit === EXPORT_HIT.binding ||
            node.type === "ExportNamedDeclaration");
        if (bindsHere && name !== null && restriction.names.has(name)) {
          report(specifier, entry, name);
        }
      }
    }
  };

  return {
    before() {
      active = entries.filter((entry) => !isFileIn(context, entry.owners));
      return active.length > 0;
    },
    ImportDeclaration(node) {
      checkDeclaration(node, getImportedName);
    },
    ExportNamedDeclaration(node) {
      checkDeclaration(node, reexportedName);
    },
    // `export * from "m"` re-exports every restricted name at once.
    ExportAllDeclaration(node) {
      if (!isStringLiteral(node.source) || node.exportKind === "type") {
        return;
      }
      const source = node.source.value;
      reportModuleLoad(node, source, MODULE_LOADING.static);
      for (const entry of exportEntriesFor(source)) {
        report(node, entry, "*");
      }
    },
    ImportExpression(node) {
      if (isStringLiteral(node.source)) {
        reportModuleLoad(node, node.source.value, MODULE_LOADING.dynamic);
      }
    },
    CallExpression(node) {
      const required = dynamicModuleSourceForEnforcement(node, context);
      if (required !== null) {
        reportModuleLoad(node, required, MODULE_LOADING.static);
        return;
      }
      reportExport(
        node,
        isAstNode(node)
          ? exportOfExpression(context, invokedCallee(node))
          : null,
        EXPORT_HIT.call,
      );
    },
    // `ns.X`, `ns["X"]`, `require("m").X`, `(await import("m")).X`.
    MemberExpression(node) {
      reportExport(node, exportOfExpression(context, node), EXPORT_HIT.binding);
    },
    JSXMemberExpression(node) {
      reportExport(node, exportOfJsxMember(context, node), EXPORT_HIT.binding);
    },
    // `const { X } = ns`, `const { X } = await import("m")`.
    VariableDeclarator(node) {
      if (!isAstNode(node.id) || node.id.type !== "ObjectPattern") {
        return;
      }
      const base = exportOfExpression(context, node.init);
      if (base === null || !isNamespaceLike(base)) {
        return;
      }
      for (const property of node.id.properties) {
        if (!isAstNode(property) || property.type !== "Property") {
          continue;
        }
        const key =
          property.computed && !isStringLiteral(property.key)
            ? null
            : getPropertyName(property.key);
        if (key !== null) {
          reportExport(
            property,
            { moduleId: base.moduleId, imported: key },
            EXPORT_HIT.binding,
          );
        }
      }
    },
  };
};
````

## .oxlint-plugins/utils.ts

````ts
// Shared AST helpers for the rules in this folder.
//
// Oxlint plugin AST nodes are passed in untyped. Each helper narrows from
// `unknown` so rule files can call them without per-call type ceremony or
// shared type-import boilerplate.

import type { ESTree, Ranged, Scope, Variable } from "@oxlint/plugins";

import { isDatabaseHandleName, MUTATION_METHODS } from "./database-access.ts";
import { canonicalModuleId } from "./module-id.ts";

export { canonicalModuleId, exactModuleId } from "./module-id.ts";

type NodeFieldNames<Node> = Node extends unknown ? keyof Node : never;

// Nodes are untrusted at this boundary: declared ESTree fields remain
// unknown until each helper validates them, without an independent field list.
export type AstNode = Ranged & { type: string } & Partial<
    Record<NodeFieldNames<ESTree.Node>, unknown>
  > &
  Record<string, unknown>;

export type FilenameContext = {
  filename?: string;
  getFilename?: () => string;
};

export const filenameForContext = (context: FilenameContext): string =>
  (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");

export const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string" &&
  "range" in node;

export const isIdentifier = (
  node: unknown,
  name?: string,
): node is AstNode & { type: "Identifier"; name: string } => {
  if (!isAstNode(node) || node.type !== "Identifier") {
    return false;
  }
  if (typeof node.name !== "string") {
    return false;
  }
  return name === undefined || node.name === name;
};

export const isStringLiteral = (
  node: unknown,
): node is AstNode & { type: "Literal"; value: string } =>
  isAstNode(node) && node.type === "Literal" && typeof node.value === "string";

// Resolve the static name of a Property or MemberExpression key:
// Identifier.name or string-Literal.value. Returns null for computed keys
// driven by a non-literal expression.
// The static text of a string literal or a zero-expression template literal:
// `` `jsonb` `` and `"jsonb"` spell the same value, so a backtick literal
// matches too.
export const staticStringValue = (node: unknown): string | null => {
  if (isStringLiteral(node)) {
    return node.value;
  }
  if (!isAstNode(node) || node.type !== "TemplateLiteral") {
    return null;
  }
  const expressions = node.expressions;
  const quasis = node.quasis;
  if (!Array.isArray(expressions) || expressions.length !== 0) {
    return null;
  }
  if (!Array.isArray(quasis) || quasis.length !== 1) {
    return null;
  }
  const quasi = quasis[0];
  if (!isAstNode(quasi)) {
    return null;
  }
  const value = quasi.value;
  if (typeof value !== "object" || value === null || !("cooked" in value)) {
    return null;
  }
  return typeof value.cooked === "string" ? value.cooked : null;
};

export const getPropertyName = (node: unknown): string | null => {
  if (isIdentifier(node)) {
    return node.name;
  }
  if (isStringLiteral(node)) {
    return node.value;
  }
  return null;
};

// Match `<object>.<property>` member access where both halves are
// Identifiers and the access is not computed.
export const isMemberAccess = (
  node: unknown,
  object: string,
  property: string,
): boolean =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  node.computed === false &&
  isIdentifier(node.object, object) &&
  isIdentifier(node.property, property);

// Match `CallExpression` whose callee is an Identifier with the given name.
export const isCallTo = (node: unknown, name: string): boolean =>
  isAstNode(node) &&
  node.type === "CallExpression" &&
  isIdentifier(node.callee, name);

// Resolve the dot-notation name of a callee: an Identifier, or a
// non-computed MemberExpression chain (e.g. `t.String`, `Schema.is`,
// `process.stderr.write`). Returns null when the chain is computed
// or the property name itself can't be resolved.
//
// If the chain is rooted at a non-Identifier expression (e.g. `foo().bar`),
// returns the bare property name ("bar") rather than null. Callers that
// match the result against a fixed allowlist must consider whether they
// need to distinguish `foo().createSafeHandler` from `createSafeHandler`.
export const getCalleeName = (callee: unknown): string | null => {
  if (isIdentifier(callee)) {
    return callee.name;
  }
  if (!isAstNode(callee) || callee.type !== "MemberExpression") {
    return null;
  }
  if (callee.computed !== false) {
    return null;
  }
  const objectName = getCalleeName(callee.object);
  const propertyName = getPropertyName(callee.property);
  if (propertyName === null) {
    return null;
  }
  return objectName === null ? propertyName : `${objectName}.${propertyName}`;
};

// Nodes that wrap an expression without changing its runtime value:
// `x as T`, `x satisfies T`, `<T>x`, `x!`, `f<T>`, `(x)`, and the optional
// chain container around `a?.b`.
export const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

// Peel value-preserving wrappers so a shape check sees the underlying
// expression. Returns the original node when no wrapping is present.
export const unwrapExpression = (node: unknown): AstNode | null => {
  let current = node;
  while (isAstNode(current) && TRANSPARENT_WRAPPERS.has(current.type)) {
    current = current.expression;
  }
  return isAstNode(current) ? current : null;
};

// Resolve an ImportSpecifier's imported binding name (Identifier.name or
// string-Literal.value). Returns null when the specifier shape is unexpected.
export const getImportedName = (specifier: unknown): string | null => {
  if (!isAstNode(specifier) || specifier.type !== "ImportSpecifier") {
    return null;
  }
  const imported = specifier.imported;
  if (isIdentifier(imported)) {
    return imported.name;
  }
  if (isStringLiteral(imported)) {
    return imported.value;
  }
  return null;
};

// Resolve an ImportSpecifier's local binding name. This differs from
// getImportedName for aliased imports such as `import { source as local }`.
export const getImportLocalName = (specifier: unknown): string | null => {
  if (!isAstNode(specifier) || specifier.type !== "ImportSpecifier") {
    return null;
  }
  return isIdentifier(specifier.local) ? specifier.local.name : null;
};

// --- Loop and async-boundary shape, shared by the await-in-loop rules -------
//
// `no-network-await-in-loop` and the type-aware `scripts/db-await-in-loop.ts`
// must agree on what counts as per-iteration work; the script mirrors these
// positions on the TypeScript AST.

// Positions of a loop node that re-run on every iteration. A `for`
// initializer and a `for-of` / `for-in` right-hand side are evaluated once, so
// an await there costs one round-trip, not one per item.
// Keyed by node type, so a lookup for any other node type misses: the value
// is optional, not a total map over a closed union.
const PER_ITERATION_LOOP_FIELDS: Record<string, readonly string[] | undefined> =
  {
    ForStatement: ["body", "test", "update"],
    ForOfStatement: ["body"],
    ForInStatement: ["body"],
    WhileStatement: ["body", "test"],
    DoWhileStatement: ["body", "test"],
  };

export const LOOP_NODE_TYPES: ReadonlySet<string> = new Set(
  Object.keys(PER_ITERATION_LOOP_FIELDS),
);

export const isPerIterationLoopPosition = (
  loop: unknown,
  child: unknown,
): boolean => {
  if (!isAstNode(loop)) {
    return false;
  }
  const fields = PER_ITERATION_LOOP_FIELDS[loop.type];
  return fields?.some((field) => loop[field] === child) ?? false;
};

const FUNCTION_NODE_TYPES: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

// The statement a `break` or `continue` leaves: its labelled statement, or
// else the nearest loop (or `switch`, for an unlabelled `break`). `null` for
// any other node, and when the jump would have to cross a function boundary.
export const abruptCompletionTarget = (node: AstNode): AstNode | null => {
  if (node.type !== "BreakStatement" && node.type !== "ContinueStatement") {
    return null;
  }
  const labelName = isIdentifier(node.label) ? node.label.name : null;
  let current = isAstNode(node.parent) ? node.parent : null;
  while (current !== null) {
    if (
      labelName !== null &&
      current.type === "LabeledStatement" &&
      isIdentifier(current.label, labelName)
    ) {
      return current;
    }
    if (
      labelName === null &&
      (LOOP_NODE_TYPES.has(current.type) ||
        (node.type === "BreakStatement" && current.type === "SwitchStatement"))
    ) {
      return current;
    }
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      return null;
    }
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return null;
};

const collectReturnArguments = (node: unknown, results: AstNode[]): void => {
  if (!isAstNode(node)) {
    return;
  }
  switch (node.type) {
    case "BlockStatement": {
      if (Array.isArray(node.body)) {
        for (const statement of node.body) {
          collectReturnArguments(statement, results);
        }
      }
      return;
    }
    case "IfStatement": {
      collectReturnArguments(node.consequent, results);
      collectReturnArguments(node.alternate, results);
      return;
    }
    case "SwitchStatement": {
      if (Array.isArray(node.cases)) {
        for (const switchCase of node.cases) {
          if (isAstNode(switchCase) && Array.isArray(switchCase.consequent)) {
            for (const statement of switchCase.consequent) {
              collectReturnArguments(statement, results);
            }
          }
        }
      }
      return;
    }
    case "TryStatement": {
      collectReturnArguments(node.block, results);
      if (isAstNode(node.handler)) {
        collectReturnArguments(node.handler.body, results);
      }
      collectReturnArguments(node.finalizer, results);
      return;
    }
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "LabeledStatement": {
      collectReturnArguments(node.body, results);
      return;
    }
    case "ReturnStatement": {
      if (isAstNode(node.argument)) {
        results.push(node.argument);
      }
      return;
    }
    default:
      return;
  }
};

// The `argument` of every `return` reachable from `node` without crossing into
// a nested function's body: a `return` inside a callback the function passes
// on is not a return of the function itself.
export const returnArguments = (node: unknown): AstNode[] => {
  const results: AstNode[] = [];
  collectReturnArguments(node, results);
  return results;
};

const isResultTryPromiseArgument = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const call = node.parent;
  if (
    !isAstNode(call) ||
    call.type !== "CallExpression" ||
    !isMemberAccess(call.callee, "Result", "tryPromise")
  ) {
    return false;
  }
  return Array.isArray(call.arguments) && call.arguments.includes(node);
};

// `Result.tryPromise(async () => ...)` and its object form
// `Result.tryPromise({ try: async () => ..., catch })` run the callback where
// it stands. Inside a loop that callback is the loop's own work, so a walk
// looking for the enclosing loop passes through this boundary instead of
// stopping at it.
export const isResultTryPromiseCallback = (fnNode: unknown): boolean => {
  if (!isAstNode(fnNode)) {
    return false;
  }
  const parent = fnNode.parent;
  if (
    isAstNode(parent) &&
    parent.type === "Property" &&
    parent.value === fnNode &&
    getPropertyName(parent.key) === "try"
  ) {
    const objectExpression = parent.parent;
    return (
      isAstNode(objectExpression) &&
      objectExpression.type === "ObjectExpression" &&
      isResultTryPromiseArgument(objectExpression)
    );
  }
  return isResultTryPromiseArgument(fnNode);
};

// Leftmost identifier of a member/call chain, descending through
// `CallExpression.callee` and `MemberExpression.object`. Computed access is
// traversed too: a generated route reads `api["copy-to-workspace"].post()`,
// and its root is still the imported client.
export const resolveChainRootName = (node: unknown): string | null => {
  const current = unwrapExpression(node);
  if (!isAstNode(current)) {
    return null;
  }
  if (current.type === "CallExpression") {
    return resolveChainRootName(current.callee);
  }
  if (current.type === "MemberExpression") {
    return resolveChainRootName(current.object);
  }
  return isIdentifier(current) ? current.name : null;
};

// --- Tailwind class strings, shared by the rules that read them -------------
//
// A class string reaches a rule as a `Literal` or a `TemplateElement`, with no
// guarantee it holds only classes: `cn()` arguments, `cva` variant maps, and
// interpolated templates all arrive here. Splitting on whitespace and the
// punctuation that separates expressions keeps the tokens usable across all
// three, and the split deliberately leaves `[` and `]` alone so an arbitrary
// variant stays one token.

const CLASS_TOKEN_SPLIT = /[\s"'`{}()]+/u;

export const classTokens = (value: string): string[] =>
  value.split(CLASS_TOKEN_SPLIT).filter(Boolean);

/**
 * The utility a token applies, with its Tailwind variant prefixes dropped
 * (`sm:`, `hover:`, `group-data-[x=true]/rail:`, `[&_pre]:`). The last colon
 * is the boundary: a colon inside an arbitrary value (`supports-[overflow:
 * clip]:`) is still followed by one.
 */
export const classBaseName = (token: string): string => {
  const boundary = token.lastIndexOf(":");
  return boundary === -1 ? token : token.slice(boundary + 1);
};

/** The variant prefixes of a token, or "" when it carries none. */
export const classVariants = (token: string): string => {
  const boundary = token.lastIndexOf(":");
  return boundary === -1 ? "" : token.slice(0, boundary);
};

// --- JSX shape, shared by the rules that read markup ------------------------

// The name a JSX element is written under, descending through the member and
// namespaced forms: `Dialog.Footer` names `Footer`, `svg:path` names `path`.
export const jsxName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXIdentifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "JSXMemberExpression") {
    return jsxName(node.property);
  }
  if (node.type === "JSXNamespacedName") {
    return jsxName(node.name);
  }
  return null;
};

// The name a JSXElement renders, or null for anything that is not one.
export const elementName = (element: unknown): string | null => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  return isAstNode(element.openingElement)
    ? jsxName(element.openingElement.name)
    : null;
};

// Every node under `root`, reached without assuming a shape: asking what a
// component renders means crossing statements, branches, and helper calls that
// a JSX-only traversal never sees.
export const everyNode = (root: unknown): AstNode[] => {
  const out: AstNode[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isAstNode(current) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    out.push(current);
    for (const [key, value] of Object.entries(current)) {
      // `parent` walks back out of the subtree under inspection.
      if (key !== "parent" && typeof value === "object") {
        pending.push(value);
      }
    }
  }
  return out;
};

// --- Files -------------------------------------------------------------------

// The linted file as a repository-relative, forward-slash path. Oxlint runs
// from the repository root, so the working directory anchors the relative
// form; a path outside it stays absolute.
export const repoRelativeFilename = (context: FilenameContext): string => {
  const filename = filenameForContext(context);
  const root = `${process.cwd().replaceAll("\\", "/")}/`;
  return filename.startsWith(root) ? filename.slice(root.length) : filename;
};

// Whether the linted file is one of `files`, each a repository-relative path
// or path suffix (`lib/s3.ts` names every file ending in it).
export const isFileIn = (
  context: FilenameContext,
  files: readonly string[],
): boolean => {
  const filename = filenameForContext(context);
  return files.some((file) => filename.endsWith(file));
};

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const TEST_DIRECTORY_PATTERN = /(?:^|\/)(?:tests?|__tests__)\//u;

// Test sources: `*.test.*` / `*.spec.*` files and anything under a `test/`,
// `tests/` or `__tests__/` directory.
export const isTestFile = (filename: string): boolean =>
  TEST_FILE_PATTERN.test(filename) || TEST_DIRECTORY_PATTERN.test(filename);

// --- Identifiers and scope ---------------------------------------------------

// An Identifier the parser emitted as a value reference (it carries a range,
// which synthetic name nodes do not).
export const isIdentifierReference = (
  node: unknown,
): node is ESTree.IdentifierReference =>
  isIdentifier(node) && Array.isArray(node.range);

export type ScopeContext = {
  sourceCode: { getScope: (node: ESTree.Node) => Scope };
};

// The variable an identifier binds to, found by walking the scope chain from
// the identifier outwards. Null for an unresolved (global) name.
export const resolveVariable = (
  context: ScopeContext,
  identifier: ESTree.IdentifierReference | ESTree.JSXIdentifier,
): Variable | null => {
  let scope: Scope | null = context.sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
};

// Whether a variable is never reassigned after its declaration, so its
// initializer is the only value it can hold.
export const isSingleAssignment = (variable: Variable): boolean =>
  variable.references.every(
    (reference) => !reference.isWrite() || reference.init,
  );

// The initializer of a variable declared exactly once and never reassigned.
export const stableInitializer = (variable: Variable): AstNode | null => {
  const definition = variable.defs.at(0);
  if (
    variable.defs.length !== 1 ||
    definition?.type !== "Variable" ||
    !isAstNode(definition.node) ||
    definition.node.type !== "VariableDeclarator" ||
    !isSingleAssignment(variable)
  ) {
    return null;
  }
  return isAstNode(definition.node.init) ? definition.node.init : null;
};

// --- Import resolution ------------------------------------------------------
//
// Rules that guard a helper or a primitive must know what a name is bound to,
// not how it is spelled: `import { x as y }`, `import * as ns` with `ns.x`,
// `const { x } = ns`, `const y = x`, `require("m").x` and `await import("m")`
// all reach the same export. The resolver answers "which export of which
// module is this expression?"; a local, a parameter, or a call result
// answers null.

// `imported` is the export name, "default" for a default import, and "*" for
// the module namespace object itself.
export type ImportedBinding = { source: string; imported: string };

export const NAMESPACE_IMPORT = "*";

const isCreateRequireReference = (
  context: ScopeContext,
  reference: ESTree.IdentifierReference,
): boolean => {
  const variable = resolveVariable(context, reference);
  const initializer = variable === null ? null : stableInitializer(variable);
  const definition = variable?.defs.at(0);
  if (
    variable === null ||
    initializer?.type !== "CallExpression" ||
    !isAstNode(definition?.node) ||
    !isAstNode(definition.parent) ||
    definition.parent.type !== "VariableDeclaration" ||
    definition.parent.kind !== "const" ||
    !isIdentifier(definition.node.id, reference.name)
  ) {
    return false;
  }
  const callee = unwrapExpression(initializer.callee);
  const base =
    callee?.type === "MemberExpression"
      ? unwrapExpression(callee.object)
      : callee;
  if (
    !isIdentifierReference(base) ||
    resolveVariable(context, base)?.defs.at(0)?.type !== "ImportBinding"
  ) {
    return false;
  }
  // Only an imported factory is eligible; a loader cannot prove itself through
  // another call to its own binding.
  const factory = resolveImportedExpressionForEnforcement(context, callee);
  return (
    factory?.imported === "createRequire" &&
    (factory.source === "node:module" || factory.source === "module")
  );
};

// Enforcement provenance recognizes stable loaders regardless of read count.
// Admission checks must separately prove that the expression is eligible.
export const dynamicModuleSourceForEnforcement = (
  node: unknown,
  context: ScopeContext,
): string | null => {
  const expression = unwrapExpression(node);
  if (!isAstNode(expression)) {
    return null;
  }
  if (expression.type === "AwaitExpression") {
    return dynamicModuleSourceForEnforcement(expression.argument, context);
  }
  if (expression.type === "ImportExpression") {
    return isStringLiteral(expression.source) ? expression.source.value : null;
  }
  if (
    expression.type === "CallExpression" &&
    isIdentifierReference(expression.callee) &&
    Array.isArray(expression.arguments) &&
    expression.arguments.length === 1 &&
    isStringLiteral(expression.arguments[0])
  ) {
    const binding = resolveVariable(context, expression.callee);
    const globalRequire =
      expression.callee.name === "require" &&
      (binding === null || binding.defs.length === 0);
    return globalRequire || isCreateRequireReference(context, expression.callee)
      ? expression.arguments[0].value
      : null;
  }
  return null;
};

// The static key of a member expression: `a.b`, `a["b"]`, `` a[`b`] ``.
export const memberPropertyName = (member: AstNode): string | null => {
  if (member.computed !== true) {
    return getPropertyName(member.property);
  }
  if (isStringLiteral(member.property)) {
    return member.property.value;
  }
  const property = member.property;
  if (
    !isAstNode(property) ||
    property.type !== "TemplateLiteral" ||
    !Array.isArray(property.expressions) ||
    property.expressions.length > 0 ||
    !Array.isArray(property.quasis)
  ) {
    return null;
  }
  const quasi: unknown = property.quasis[0];
  if (!isAstNode(quasi)) {
    return null;
  }
  const value: unknown = quasi.value;
  const cooked =
    typeof value === "object" && value !== null
      ? Reflect.get(value, "cooked")
      : undefined;
  return typeof cooked === "string" ? cooked : null;
};

// The export read by `namespace.property` when `base` is a module namespace.
const memberOfNamespace = (
  base: ImportedBinding | null,
  property: string | null,
): ImportedBinding | null =>
  base?.imported === NAMESPACE_IMPORT && property !== null
    ? { source: base.source, imported: property }
    : null;

// The key a destructuring pattern reads for `binding`: `{ x }`, `{ x: y }`,
// `{ x = d }`, `{ "x": y }`.
export const patternKeyFor = (
  pattern: AstNode,
  binding: unknown,
): string | null => {
  if (!Array.isArray(pattern.properties)) {
    return null;
  }
  for (const property of pattern.properties) {
    if (!isAstNode(property) || property.type !== "Property") {
      continue;
    }
    const value = isAstNode(property.value) ? property.value : null;
    const target =
      value?.type === "AssignmentPattern" ? value.left : (value ?? null);
    if (target !== binding) {
      continue;
    }
    if (property.computed === true && !isStringLiteral(property.key)) {
      return null;
    }
    return getPropertyName(property.key);
  }
  return null;
};

const bindingFromVariable = (
  context: ScopeContext,
  variable: Variable,
  seen: Set<unknown>,
): ImportedBinding | null => {
  const definition = variable.defs.at(0);
  if (variable.defs.length !== 1 || definition === undefined) {
    return null;
  }
  const node: unknown = definition.node;
  if (definition.type === "ImportBinding") {
    const declaration: unknown = definition.parent;
    if (
      !isAstNode(node) ||
      node.importKind === "type" ||
      !isAstNode(declaration) ||
      declaration.type !== "ImportDeclaration" ||
      declaration.importKind === "type" ||
      !isStringLiteral(declaration.source)
    ) {
      return null;
    }
    const source = declaration.source.value;
    if (node.type === "ImportNamespaceSpecifier") {
      return { source, imported: NAMESPACE_IMPORT };
    }
    if (node.type === "ImportDefaultSpecifier") {
      return { source, imported: "default" };
    }
    const imported = getImportedName(node);
    return imported === null ? null : { source, imported };
  }
  if (
    definition.type !== "Variable" ||
    !isAstNode(node) ||
    node.type !== "VariableDeclarator" ||
    !isSingleAssignment(variable)
  ) {
    return null;
  }
  const loaded = dynamicModuleSourceForEnforcement(node.init, context);
  const init =
    loaded === null
      ? resolveImportedExpressionForEnforcement(context, node.init, seen)
      : { source: loaded, imported: NAMESPACE_IMPORT };
  if (init === null) {
    return null;
  }
  if (isIdentifier(node.id)) {
    return init;
  }
  if (isAstNode(node.id) && node.id.type === "ObjectPattern") {
    return memberOfNamespace(init, patternKeyFor(node.id, definition.name));
  }
  return null;
};

// Enforcement provenance; recognizing a binding never grants an exemption.
// The module export an expression evaluates to, or null when it is anything
// else: a local, a parameter, a call result, an unresolved global.
export const resolveImportedExpressionForEnforcement = (
  context: ScopeContext,
  node: unknown,
  seen = new Set<unknown>(),
): ImportedBinding | null => {
  const expression = unwrapExpression(node);
  if (!isAstNode(expression) || seen.has(expression)) {
    return null;
  }
  seen.add(expression);
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    return variable === null
      ? null
      : bindingFromVariable(context, variable, seen);
  }
  if (expression.type === "MemberExpression") {
    const loaded = dynamicModuleSourceForEnforcement(
      expression.object,
      context,
    );
    const base =
      loaded === null
        ? resolveImportedExpressionForEnforcement(
            context,
            expression.object,
            seen,
          )
        : { source: loaded, imported: NAMESPACE_IMPORT };
    return memberOfNamespace(base, memberPropertyName(expression));
  }
  return null;
};

// A module an import may come from: a bare package specifier or a repository
// path without extension (`apps/api/src/lib/escape-like`), or a predicate over
// the canonical id.
export type ModuleMatcher = string | ((moduleId: string) => boolean);

export const moduleMatches = (
  matcher: ModuleMatcher,
  moduleId: string,
): boolean =>
  typeof matcher === "function" ? matcher(moduleId) : matcher === moduleId;

// The resolved import behind `node` with its module in canonical form.
export type ResolvedImport = { moduleId: string; imported: string };

export const resolveImport = (
  context: ScopeContext & FilenameContext,
  node: unknown,
): ResolvedImport | null => {
  const binding = resolveImportedExpressionForEnforcement(context, node);
  if (binding === null) {
    return null;
  }
  return {
    moduleId: canonicalModuleId(binding.source, repoRelativeFilename(context)),
    imported: binding.imported,
  };
};

// Whether `node` evaluates to one of `names` exported by a module accepted by
// `modules`. Use NAMESPACE_IMPORT as a name to accept the namespace object.
export type ImportedFromOptions = {
  context: ScopeContext & FilenameContext;
  node: unknown;
  modules: readonly ModuleMatcher[];
  names: ReadonlySet<string>;
};

export const isImportedFrom = ({
  context,
  node,
  modules,
  names,
}: ImportedFromOptions): boolean => {
  const resolved = resolveImport(context, node);
  return (
    resolved !== null &&
    names.has(resolved.imported) &&
    modules.some((matcher) => moduleMatches(matcher, resolved.moduleId))
  );
};

// The function a call invokes, seen through the forms that call it
// indirectly: `(0, f)()`, `f.call(...)`, `f.apply(...)`.
export const invokedCallee = (call: AstNode): AstNode | null => {
  const callee = unwrapExpression(call.callee);
  if (!isAstNode(callee)) {
    return null;
  }
  if (
    callee.type === "SequenceExpression" &&
    Array.isArray(callee.expressions)
  ) {
    return unwrapExpression(callee.expressions.at(-1));
  }
  if (callee.type === "MemberExpression") {
    const method = memberPropertyName(callee);
    if (method === "call" || method === "apply") {
      return unwrapExpression(callee.object);
    }
  }
  return callee;
};

// --- Database writes --------------------------------------------------------
//
// A Drizzle row write: `<handle>.insert(...)`, `.update(...)` or `.delete(...)`
// where the receiver is a database handle (`tx` / `db` / `trx`, a camel-cased
// name ending in `Tx` / `Db`, a member with such a name, a `getDb()`-style
// call, or a parameter of a `.transaction(...)` callback or typed as a
// transaction), or `<receiver>.execute(sql`...`)` whose static SQL inserts,
// updates or deletes rows.

type DatabaseWriteContext = ImportedFromOptions["context"];

// Guards the identifier-to-initializer walk against cycles.
const MAX_SQL_RESOLVE_DEPTH = 4;

const GET_DB_CALL = /^get[A-Za-z]*Db$/u;
const TRANSACTION_TYPE = /(?:^|[a-z])(?:Transaction|Tx)$|^(?:Db|DbOrTx)$/u;

// Static SQL that writes rows. Interpolations are joined as a placeholder
// token so `UPDATE ${table} AS t SET` still reads as one statement.
const WRITE_SQL = [
  /\bINSERT\s+INTO\b/iu,
  /\bDELETE\s+FROM\b/iu,
  /\bUPDATE\s+(?:ONLY\s+)?\S+(?:\s+(?:AS\s+)?\w+)?\s+SET\b/iu,
];
const SQL_PLACEHOLDER = " __value__ ";

const DRIZZLE_SQL: ReadonlySet<string> = new Set(["sql"]);

const isDrizzleModule = (moduleId: string): boolean =>
  moduleId === "drizzle-orm" || moduleId.startsWith("drizzle-orm/");

const typeAnnotationName = (identifier: unknown): string | null => {
  if (!isAstNode(identifier) || !isAstNode(identifier.typeAnnotation)) {
    return null;
  }
  const annotation = identifier.typeAnnotation.typeAnnotation;
  if (!isAstNode(annotation) || annotation.type !== "TSTypeReference") {
    return null;
  }
  const typeName = annotation.typeName;
  if (isIdentifier(typeName)) {
    return typeName.name;
  }
  return isAstNode(typeName) && typeName.type === "TSQualifiedName"
    ? getCalleeName(typeName.right)
    : null;
};

// Whether a function is the callback of `<handle>.transaction(...)` or of a
// handle-named runner such as `safeDb(...)`, which passes its callback a handle.
const isTransactionCallback = (fn: unknown): boolean => {
  const call = isAstNode(fn) ? fn.parent : null;
  if (
    !isAstNode(call) ||
    call.type !== "CallExpression" ||
    !Array.isArray(call.arguments) ||
    !call.arguments.includes(fn)
  ) {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  if (isIdentifierReference(callee)) {
    return isDatabaseHandleName(callee.name);
  }
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const property = memberPropertyName(callee);
  return (
    property !== null &&
    (property === "transaction" || isDatabaseHandleName(property))
  );
};

const isTransactionParameter = (variable: Variable): boolean => {
  const definition = variable.defs.at(0);
  if (variable.defs.length !== 1 || definition?.type !== "Parameter") {
    return false;
  }
  const typeName = typeAnnotationName(definition.name);
  return (
    (typeName !== null && TRANSACTION_TYPE.test(typeName)) ||
    isTransactionCallback(definition.node)
  );
};

const isDatabaseHandle = (
  context: DatabaseWriteContext,
  node: unknown,
): boolean => {
  const receiver = unwrapExpression(node);
  if (receiver === null) {
    return false;
  }
  if (isIdentifierReference(receiver)) {
    if (isDatabaseHandleName(receiver.name)) {
      return true;
    }
    const variable = resolveVariable(context, receiver);
    return variable !== null && isTransactionParameter(variable);
  }
  if (receiver.type === "MemberExpression") {
    const property = memberPropertyName(receiver);
    return property !== null && isDatabaseHandleName(property);
  }
  if (receiver.type === "CallExpression") {
    const name = getCalleeName(receiver.callee)?.split(".").at(-1);
    return name !== undefined && GET_DB_CALL.test(name);
  }
  return false;
};

// The static text of a drizzle `sql` template, or of a const holding one.
const writeSqlText = (
  context: DatabaseWriteContext,
  node: unknown,
  depth = 0,
): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null || depth > MAX_SQL_RESOLVE_DEPTH) {
    return null;
  }
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    const init = variable === null ? null : stableInitializer(variable);
    return init === null ? null : writeSqlText(context, init, depth + 1);
  }
  if (
    expression.type !== "TaggedTemplateExpression" ||
    !isImportedFrom({
      context,
      node: expression.tag,
      modules: [isDrizzleModule],
      names: DRIZZLE_SQL,
    }) ||
    !isAstNode(expression.quasi) ||
    !Array.isArray(expression.quasi.quasis)
  ) {
    return null;
  }
  return expression.quasi.quasis
    .map((quasi: unknown) => {
      const value = isAstNode(quasi) ? quasi.value : null;
      return typeof value === "object" &&
        value !== null &&
        "raw" in value &&
        typeof value.raw === "string"
        ? value.raw
        : "";
    })
    .join(SQL_PLACEHOLDER);
};

export const isDatabaseWriteCall = (
  context: DatabaseWriteContext,
  node: unknown,
): boolean => {
  const call = unwrapExpression(node);
  if (call?.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const method = memberPropertyName(callee);
  if (method !== null && MUTATION_METHODS.has(method)) {
    return isDatabaseHandle(context, callee.object);
  }
  if (method !== "execute" || !Array.isArray(call.arguments)) {
    return false;
  }
  const text = writeSqlText(context, call.arguments.at(0));
  return text !== null && WRITE_SQL.some((pattern) => pattern.test(text));
};

// `a`, `a.b`, `a.b.c`: the dotted name of a table reference, or null.
const dottedName = (node: unknown, depth = 0): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null || depth > MAX_SQL_RESOLVE_DEPTH) {
    return null;
  }
  if (isIdentifier(expression)) {
    return expression.name;
  }
  if (expression.type !== "MemberExpression") {
    return null;
  }
  const object = dottedName(expression.object, depth + 1);
  const property = memberPropertyName(expression);
  return object === null || property === null ? null : `${object}.${property}`;
};

const SQL_WRITE_TARGET =
  /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE(?:\s+ONLY)?)\s+([\w."]+)/iu;

/**
 * What a write `isDatabaseWriteCall` accepts touches, as `<verb>:<table>`
 * (`insert:entities`, `update:schema.members`). Raw SQL reads the verb and
 * table from its static text. `?` stands for a table the source does not
 * name statically. Lets a per-owner budget tell one write from another
 * instead of counting them.
 */
export const databaseWriteTarget = (
  context: DatabaseWriteContext,
  node: unknown,
): string => {
  const call = unwrapExpression(node);
  const callee =
    call?.type === "CallExpression" ? unwrapExpression(call.callee) : null;
  const method =
    callee?.type === "MemberExpression" ? memberPropertyName(callee) : null;
  const args =
    call !== null && Array.isArray(call.arguments) ? call.arguments : [];
  if (method !== null && MUTATION_METHODS.has(method)) {
    return `${method}:${dottedName(args.at(0)) ?? "?"}`;
  }
  const text = writeSqlText(context, args.at(0));
  const match = text === null ? null : SQL_WRITE_TARGET.exec(text);
  const verb = match?.at(1)?.split(/\s+/u).at(0)?.toLowerCase();
  const table = match?.at(2)?.replaceAll('"', "");
  const named =
    table === undefined || table === SQL_PLACEHOLDER.trim() ? "?" : table;
  return `${verb ?? "execute"}:${named}`;
};
````
