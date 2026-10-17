# stella/stella source snapshot at d78d0b901f89bb3b979375dee5a7bdd29ce325d7

## .oxlint-plugins/bun-test-hygiene.ts

````ts
// Test-run hygiene for suites written against `bun:test`.
//
// Oxlint's jest and vitest rules recognise their own frameworks' imports and
// globals, not `bun:test`, so a committed `test.only` or an unexplained
// `test.skip` in a Bun suite passes lint. These rules resolve each test
// function through its import (named, aliased, or a namespace member such as
// `bt.test`) and only consider calls that reach a `bun:test` export.
//
// no-focused-tests
//   Flagged: test.only(...), it.only(...), describe.only(...), test["only"],
//            test.only.each(table)(...), test.if(condition).only(...)
//
// no-disabled-tests
//   Flagged without a reason comment on the same line or directly above:
//            test.skip(...), test.todo(...), describe.skip(...), xtest(...),
//            xit(...), xdescribe(...)
//   Allowed: the conditional forms (`test.skipIf(condition)`,
//            `test.todoIf(condition)`, `test.if(condition)`), and a disabled
//            registration inside a branch of the block it belongs to
//            (`if (!databaseUrl) describe.skip(...) else describe(...)`);
//            both state their reason in code.
//
// no-identical-title
//   Flagged: two tests (or two describe blocks) with the same static title in
//            the same block. Titles built from expressions and `.each` format
//            strings are not compared, and each branch of a conditional is a
//            block of its own, so the skipped and the real registration of
//            one suite may share a title.
//
// no-promise-matchers
//   Flagged: expect(promise).rejects.*, expect(promise).resolves.*, also
//            after `.not`, on the `bun:test` `expect` (named, aliased, or a
//            namespace member).
//            An `expect(...).rejects` that is not awaited can settle after the
//            test ends, so its failure lands on a later test or is lost.
//   Allowed: `expect(await promise)...` for a resolved value, and
//            `expect(await rejectionOf(promise))...` (from
//            `@stll/property-testing/rejection`) for a rejection. Another
//            framework's `expect` (Playwright) is not considered.
//
// no-unmanaged-database-client
//   Flagged: constructing a database client, called or with `new`, through
//            its import: `SQL` from `bun` (and `Bun.SQL`), `drizzle(url)` or
//            `drizzle({ connection })` from a network drizzle driver,
//            `postgres` from `postgres`, `Pool` and `Client` from `pg`.
//   Allowed: `drizzle({ client })`, which wraps a client opened elsewhere.
//   The gated suites run in one process, so a client a test leaves open
//   holds its connections for the rest of the run. Tests open them through
//   `apps/api/src/tests/gated-test-database.ts`, which closes every client it
//   opens; the lint config exempts that module.

import { eslintCompatPlugin } from "@oxlint/plugins";
import { panic } from "better-result";

import {
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  isStringLiteral,
  memberPropertyName,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode, ScopeContext } from "./utils.ts";

const BUN_TEST_MODULE = "bun:test";
const EXPECT_EXPORT = "expect";

const FORCED_DATABASE_DROP =
  /(?:^|;)\s*DROP\s+DATABASE\b[^;]*(?:\bWITH\s*)?\(\s*FORCE\b/iu;
const SQL_IDENTIFIER_CHARACTER = /[A-Za-z0-9_$\u0080-\u{10ffff}]/u;
const SQL_DOLLAR_QUOTE =
  /\$(?:[A-Za-z_\u0080-\u{10ffff}][A-Za-z0-9_\u0080-\u{10ffff}]*)?\$/uy;

type SqlMaskState =
  | { type: "code" }
  | { type: "line-comment" }
  | { type: "block-comment"; depth: number }
  | { type: "quoted-identifier" }
  | { type: "quoted-string"; syntax: "standard" | "escaped" }
  | { type: "dollar-quoted"; delimiter: string };

// A quote inside a comment belongs to that comment, and vice versa.
const maskSqlValuesAndComments = (text: string) => {
  const masked: string[] = [];
  let state: SqlMaskState = { type: "code" };
  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);
    const next = text.charAt(index + 1);
    switch (state.type) {
      case "line-comment":
        if (character === "\n" || character === "\r") {
          masked.push(character);
          state = { type: "code" };
        }
        continue;
      case "block-comment":
        if (character === "/" && next === "*") {
          state.depth++;
          index++;
        } else if (character === "*" && next === "/") {
          state.depth--;
          index++;
          if (state.depth === 0) {
            state = { type: "code" };
          }
        }
        continue;
      case "quoted-identifier":
        if (character === '"') {
          if (next === '"') {
            index++;
          } else {
            state = { type: "code" };
          }
        }
        continue;
      case "quoted-string":
        if (state.syntax === "escaped" && character === "\\") {
          index++;
        } else if (character === "'") {
          if (next === "'") {
            index++;
          } else {
            state = { type: "code" };
          }
        }
        continue;
      case "dollar-quoted":
        if (text.startsWith(state.delimiter, index)) {
          index += state.delimiter.length - 1;
          state = { type: "code" };
        }
        continue;
      case "code":
        if (character === "-" && next === "-") {
          masked.push(" ");
          state = { type: "line-comment" };
          index++;
          continue;
        }
        if (character === "/" && next === "*") {
          masked.push(" ");
          state = { type: "block-comment", depth: 1 };
          index++;
          continue;
        }
        if (character === '"') {
          masked.push(" __value__ ");
          state = { type: "quoted-identifier" };
          continue;
        }
        if (character === "'") {
          masked.push(" __value__ ");
          state = {
            type: "quoted-string",
            syntax:
              /[eE]/u.test(text.charAt(index - 1)) &&
              !SQL_IDENTIFIER_CHARACTER.test(text.charAt(index - 2))
                ? "escaped"
                : "standard",
          };
          continue;
        }
        if (
          character === "$" &&
          !SQL_IDENTIFIER_CHARACTER.test(text.charAt(index - 1))
        ) {
          SQL_DOLLAR_QUOTE.lastIndex = index;
          const delimiter = SQL_DOLLAR_QUOTE.exec(text)?.at(0);
          if (delimiter !== undefined) {
            masked.push(" __value__ ");
            state = { type: "dollar-quoted", delimiter };
            index += delimiter.length - 1;
            continue;
          }
        }
        masked.push(character);
        continue;
      default: {
        state satisfies never;
        panic("Unhandled SQL masking state");
      }
    }
  }
  return masked.join("");
};

const databaseDropText = (node: unknown) => {
  if (isStringLiteral(node)) {
    return node.value;
  }
  if (
    !isAstNode(node) ||
    node.type !== "TemplateLiteral" ||
    !Array.isArray(node.quasis)
  ) {
    return null;
  }
  return node.quasis
    .map((quasi: unknown) => {
      const value = isAstNode(quasi) ? quasi.value : null;
      return typeof value === "object" &&
        value !== null &&
        "cooked" in value &&
        typeof value.cooked === "string"
        ? value.cooked
        : "";
    })
    .join(" __identifier__ ");
};

const TEST_KIND = { describe: "describe", test: "test" } as const;
type TestKind = (typeof TEST_KIND)[keyof typeof TEST_KIND];

// `bun:test` exports that register a test or a block, by what they register.
const TEST_FUNCTIONS: ReadonlyMap<string, TestKind> = new Map([
  ["describe", TEST_KIND.describe],
  ["xdescribe", TEST_KIND.describe],
  ["it", TEST_KIND.test],
  ["test", TEST_KIND.test],
  ["xit", TEST_KIND.test],
  ["xtest", TEST_KIND.test],
]);

// Exports that are the disabled form of a test function themselves.
const DISABLED_FUNCTIONS = new Set(["xdescribe", "xit", "xtest"]);

const PROMISE_MATCHER_PROPERTIES = new Set(["rejects", "resolves"]);
const NEGATION_MODIFIER = "not";

const FOCUS_MODIFIER = "only";
const DISABLE_MODIFIERS = new Set(["skip", "todo"]);
const EACH_MODIFIER = "each";

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

// Comments that configure tooling rather than explain anything. The fixture
// harness (scripts/check-oxlint-fixture-counts.ts) rewrites disable directives
// into `fixture-expect` markers, which are directives too.
const DIRECTIVE_COMMENT =
  /^\s*(?:oxlint-|eslint-|@ts-|expect-clean:|fixture-expect\b|prettier-ignore)/u;
const HAS_LETTER = /\p{L}/u;

type TestRegistration = {
  call: AstNode;
  exportName: string;
  kind: TestKind;
  // Member and call modifiers between the export and the registering call,
  // in source order: `test.only.each(table)(...)` has ["only", "each"].
  modifiers: string[];
};

// A call is the registering one when nothing further chains off it:
// `test.if(condition)` inside `test.if(condition)("title", fn)` only selects
// a modifier, and reporting both would count the same test twice.
const isOutermostCall = (call: AstNode): boolean => {
  const parent = call.parent;
  if (!isAstNode(parent)) {
    return true;
  }
  if (parent.type === "CallExpression" && parent.callee === call) {
    return false;
  }
  return !(parent.type === "MemberExpression" && parent.object === call);
};

// The `bun:test` registration a call performs, following the callee chain
// through member modifiers (`.only`, `["skip"]`) and modifier calls
// (`.if(condition)`, `.each(table)`) down to the imported test function.
const testRegistration = (
  context: ScopeContext,
  call: unknown,
): TestRegistration | null => {
  if (
    !isAstNode(call) ||
    call.type !== "CallExpression" ||
    !isOutermostCall(call)
  ) {
    return null;
  }
  const modifiers: string[] = [];
  let current = unwrapExpression(call.callee);
  while (current !== null) {
    const binding = resolveImportedExpressionForEnforcement(context, current);
    const kind =
      binding?.source === BUN_TEST_MODULE
        ? TEST_FUNCTIONS.get(binding.imported)
        : undefined;
    if (binding !== null && kind !== undefined) {
      return { call, exportName: binding.imported, kind, modifiers };
    }
    if (current.type === "MemberExpression") {
      const modifier = memberPropertyName(current);
      if (modifier === null) {
        return null;
      }
      modifiers.unshift(modifier);
      current = unwrapExpression(current.object);
      continue;
    }
    if (current.type !== "CallExpression") {
      return null;
    }
    current = unwrapExpression(current.callee);
  }
  return null;
};

const describeRegistration = ({
  exportName,
  modifiers,
}: TestRegistration): string => [exportName, ...modifiers].join(".");

type SourceComment = { range: [number, number]; value: string };

const lineStartOf = (text: string, offset: number): number =>
  text.lastIndexOf("\n", offset - 1) + 1;

const lineEndOf = (text: string, offset: number): number => {
  const end = text.indexOf("\n", offset);
  return end === -1 ? text.length : end;
};

const isReasonComment = (comment: SourceComment): boolean =>
  !DIRECTIVE_COMMENT.test(comment.value) && HAS_LETTER.test(comment.value);

type ReasonLookup = {
  comments: readonly SourceComment[];
  node: AstNode;
  text: string;
};

// A reason is a non-directive comment on the call's first line, or in the
// unbroken run of own-line comments directly above it (directives such as a
// disable comment may sit in that run).
const hasReasonComment = ({ comments, node, text }: ReasonLookup): boolean => {
  const lineStart = lineStartOf(text, node.range[0]);
  const lineEnd = lineEndOf(text, node.range[0]);
  if (
    comments.some(
      (comment) =>
        comment.range[0] >= lineStart &&
        comment.range[0] < lineEnd &&
        isReasonComment(comment),
    )
  ) {
    return true;
  }
  let boundary = lineStart;
  for (const comment of comments.toReversed()) {
    if (comment.range[1] > boundary) {
      continue;
    }
    const gap = text.slice(comment.range[1], boundary);
    const commentLineStart = lineStartOf(text, comment.range[0]);
    if (
      gap.trim() !== "" ||
      gap.split("\n").length > 2 ||
      text.slice(commentLineStart, comment.range[0]).trim() !== ""
    ) {
      return false;
    }
    if (isReasonComment(comment)) {
      return true;
    }
    boundary = commentLineStart;
  }
  return false;
};

const isSourceComment = (value: unknown): value is SourceComment =>
  typeof value === "object" &&
  value !== null &&
  "value" in value &&
  typeof value.value === "string" &&
  "range" in value &&
  Array.isArray(value.range) &&
  value.range.length === 2 &&
  value.range.every((offset) => typeof offset === "number");

// A title the rule can compare: a string literal or a template without
// substitutions.
const staticTitle = (node: unknown): string | null => {
  const title = unwrapExpression(node);
  if (isStringLiteral(title)) {
    return title.value;
  }
  if (
    !isAstNode(title) ||
    title.type !== "TemplateLiteral" ||
    !Array.isArray(title.expressions) ||
    title.expressions.length > 0 ||
    !Array.isArray(title.quasis)
  ) {
    return null;
  }
  const quasi: unknown = title.quasis.at(0);
  if (!isAstNode(quasi)) {
    return null;
  }
  // `TemplateElement.value` is a plain `{ raw, cooked }` record, not a node.
  const value: unknown = quasi.value;
  return typeof value === "object" &&
    value !== null &&
    "cooked" in value &&
    typeof value.cooked === "string"
    ? value.cooked
    : null;
};

// Whether `node` is one of the mutually exclusive arms of its parent.
const isConditionalBranch = (node: AstNode): boolean => {
  const parent = node.parent;
  if (!isAstNode(parent)) {
    return false;
  }
  if (
    parent.type === "IfStatement" ||
    parent.type === "ConditionalExpression"
  ) {
    return parent.consequent === node || parent.alternate === node;
  }
  return parent.type === "LogicalExpression" && parent.right === node;
};

type EnclosingBlock = { node: unknown; conditional: boolean };

// The block a registration belongs to: the nearest enclosing function (a
// describe callback, or a helper), conditional branch, or the file itself.
const enclosingBlock = (node: AstNode): EnclosingBlock => {
  let current: unknown = node;
  while (isAstNode(current)) {
    if (isConditionalBranch(current)) {
      return { node: current, conditional: true };
    }
    const parent = current.parent;
    if (
      isAstNode(parent) &&
      (FUNCTION_TYPES.has(parent.type) || parent.type === "Program")
    ) {
      return { node: parent, conditional: false };
    }
    current = parent;
  }
  return { node: null, conditional: false };
};

const mentionsBunTest = (text: string): boolean =>
  text.includes(BUN_TEST_MODULE);

// Exports that open a database connection pool when constructed, by module.
const CLIENT_CONSTRUCTORS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["bun", new Set(["SQL"])],
  ["postgres", new Set(["default"])],
  ["pg", new Set(["Pool", "Client"])],
]);

// Drizzle drivers whose `drizzle` opens its own client from a URL or a
// `connection` option.
const DRIZZLE_NETWORK_DRIVERS = new Set([
  "drizzle-orm/bun-sql",
  "drizzle-orm/node-postgres",
  "drizzle-orm/postgres-js",
]);

const CLIENT_CONSTRUCTOR_HINT = /\bSQL\b|drizzle|postgres|\bpg\b/u;

// `Bun.SQL`, with `Bun` the runtime global rather than a local binding.
const isGlobalBunSql = (context: ScopeContext, callee: AstNode): boolean => {
  if (
    callee.type !== "MemberExpression" ||
    memberPropertyName(callee) !== "SQL"
  ) {
    return false;
  }
  const object = unwrapExpression(callee.object);
  return (
    isIdentifierReference(object) &&
    object.name === "Bun" &&
    resolveVariable(context, object) === null
  );
};

// `drizzle({ client })` wraps a client something else opened and closes; any
// other argument (a URL, a `connection` option, or nothing) makes the driver
// open one.
const wrapsProvidedClient = (argument: unknown): boolean => {
  const options = unwrapExpression(argument);
  if (
    !isAstNode(options) ||
    options.type !== "ObjectExpression" ||
    !Array.isArray(options.properties)
  ) {
    return false;
  }
  const keys = new Set(
    options.properties.map((property: unknown) =>
      isAstNode(property) && property.type === "Property"
        ? getPropertyName(property.key)
        : null,
    ),
  );
  return keys.has("client") && !keys.has("connection");
};

// The client a call or `new` expression constructs, named for the report, or
// null when it constructs none.
const constructedClient = (
  context: ScopeContext,
  node: unknown,
): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  const callee = unwrapExpression(node.callee);
  if (!isAstNode(callee)) {
    return null;
  }
  if (isGlobalBunSql(context, callee)) {
    return "Bun.SQL";
  }
  const binding = resolveImportedExpressionForEnforcement(context, callee);
  if (binding === null) {
    return null;
  }
  if (CLIENT_CONSTRUCTORS.get(binding.source)?.has(binding.imported) === true) {
    return binding.imported === "default"
      ? binding.source
      : `${binding.imported} from "${binding.source}"`;
  }
  if (
    node.type === "CallExpression" &&
    binding.imported === "drizzle" &&
    DRIZZLE_NETWORK_DRIVERS.has(binding.source) &&
    !wrapsProvidedClient(
      Array.isArray(node.arguments) ? node.arguments.at(0) : undefined,
    )
  ) {
    return `drizzle from "${binding.source}"`;
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "bun-test-hygiene" },
  rules: {
    "no-forced-database-drop": {
      meta: {
        type: "problem",
        messages: {
          forcedDrop:
            "Close fixture-owned database clients before a normal DROP DATABASE. FORCE requires backend-termination privileges and can terminate another fixture's sessions.",
        },
      },
      createOnce(context) {
        const report = (
          node: NonNullable<Parameters<typeof context.report>[0]["node"]>,
        ) => {
          const text = databaseDropText(node);
          if (
            text !== null &&
            FORCED_DATABASE_DROP.test(maskSqlValuesAndComments(text))
          ) {
            context.report({ node, messageId: "forcedDrop" });
          }
        };
        return {
          before() {
            return /\bFORCE\b|\\[ux]/iu.test(context.sourceCode.text);
          },
          Literal: report,
          TemplateLiteral: report,
        };
      },
    },
    "no-focused-tests": {
      meta: {
        type: "problem",
        messages: {
          focused:
            "`{{call}}` focuses the run on this test, so every other test in " +
            "the file silently stops running. Remove `.only` before committing.",
        },
      },
      createOnce(context) {
        return {
          before() {
            return mentionsBunTest(context.sourceCode.text);
          },
          CallExpression(node) {
            const registration = testRegistration(context, node);
            if (
              registration === null ||
              !registration.modifiers.includes(FOCUS_MODIFIER)
            ) {
              return;
            }
            context.report({
              node,
              messageId: "focused",
              data: { call: describeRegistration(registration) },
            });
          },
        };
      },
    },
    "no-disabled-tests": {
      meta: {
        type: "problem",
        messages: {
          disabled:
            "`{{call}}` disables this test without a stated reason. Add a " +
            "comment on the same line or directly above saying why it is " +
            "disabled and what re-enables it, use a conditional form " +
            "(`.skipIf(condition)`, `.todoIf(condition)`), or remove it.",
        },
      },
      createOnce(context) {
        let comments: readonly SourceComment[] | null = null;

        return {
          before() {
            comments = null;
            return mentionsBunTest(context.sourceCode.text);
          },
          CallExpression(node) {
            const registration = testRegistration(context, node);
            if (
              registration === null ||
              (!DISABLED_FUNCTIONS.has(registration.exportName) &&
                !registration.modifiers.some((modifier) =>
                  DISABLE_MODIFIERS.has(modifier),
                ))
            ) {
              return;
            }
            if (enclosingBlock(registration.call).conditional) {
              return;
            }
            comments ??= context.sourceCode
              .getAllComments()
              .filter(isSourceComment);
            if (
              hasReasonComment({
                comments,
                node: registration.call,
                text: context.sourceCode.text,
              })
            ) {
              return;
            }
            context.report({
              node,
              messageId: "disabled",
              data: { call: describeRegistration(registration) },
            });
          },
        };
      },
    },
    "no-promise-matchers": {
      meta: {
        type: "problem",
        messages: {
          promiseMatcher:
            "`expect(...).{{property}}` can settle after the test ends when " +
            "it is not awaited. `await` the promise instead " +
            "(`expect(await promise)...`), or capture the rejection with " +
            "`rejectionOf` from `@stll/property-testing/rejection` " +
            "(`expect(await rejectionOf(promise))...`).",
        },
      },
      createOnce(context) {
        return {
          before() {
            return mentionsBunTest(context.sourceCode.text);
          },
          MemberExpression(node) {
            if (!isAstNode(node)) {
              return;
            }
            const property = memberPropertyName(node);
            if (
              property === null ||
              !PROMISE_MATCHER_PROPERTIES.has(property)
            ) {
              return;
            }
            // `expect(p).not.rejects` puts the modifier between the call and
            // the matcher property.
            let subject = unwrapExpression(node.object);
            while (
              isAstNode(subject) &&
              subject.type === "MemberExpression" &&
              memberPropertyName(subject) === NEGATION_MODIFIER
            ) {
              subject = unwrapExpression(subject.object);
            }
            if (!isAstNode(subject) || subject.type !== "CallExpression") {
              return;
            }
            const binding = resolveImportedExpressionForEnforcement(
              context,
              subject.callee,
            );
            if (
              binding?.source !== BUN_TEST_MODULE ||
              binding.imported !== EXPECT_EXPORT
            ) {
              return;
            }
            context.report({
              node,
              messageId: "promiseMatcher",
              data: { property },
            });
          },
        };
      },
    },
    "no-unmanaged-database-client": {
      meta: {
        type: "problem",
        messages: {
          unmanagedClient:
            "This test constructs a database client ({{client}}) that nothing " +
            "is bound to close. Open it through `openGatedTestDatabase` or " +
            "`withGatedTestClients` from `@/api/tests/gated-test-database`, " +
            "which close every client they open even when cleanup throws.",
        },
      },
      createOnce(context) {
        const report = (
          node: NonNullable<Parameters<typeof context.report>[0]["node"]>,
        ) => {
          const client = constructedClient(context, node);
          if (client === null) {
            return;
          }
          context.report({
            node,
            messageId: "unmanagedClient",
            data: { client },
          });
        };

        return {
          before() {
            return CLIENT_CONSTRUCTOR_HINT.test(context.sourceCode.text);
          },
          CallExpression(node) {
            report(node);
          },
          NewExpression(node) {
            report(node);
          },
        };
      },
    },
    "no-identical-title": {
      meta: {
        type: "problem",
        messages: {
          identicalTitle:
            "Another {{kind}} in this block is already titled '{{title}}'. " +
            "Rename one to say what differs, so a failure names the case " +
            "that failed.",
        },
      },
      createOnce(context) {
        // Titles seen per enclosing block, keyed by kind and title.
        const titlesByBlock = new Map<unknown, Set<string>>();

        return {
          before() {
            titlesByBlock.clear();
            return mentionsBunTest(context.sourceCode.text);
          },
          CallExpression(node) {
            const registration = testRegistration(context, node);
            if (
              registration === null ||
              registration.modifiers.includes(EACH_MODIFIER)
            ) {
              return;
            }
            const { arguments: args } = registration.call;
            const title = staticTitle(
              Array.isArray(args) ? args.at(0) : undefined,
            );
            if (title === null) {
              return;
            }
            const block = enclosingBlock(registration.call).node;
            const seen = titlesByBlock.get(block) ?? new Set<string>();
            titlesByBlock.set(block, seen);
            const key = `${registration.kind}\u0000${title}`;
            if (!seen.has(key)) {
              seen.add(key);
              return;
            }
            context.report({
              node,
              messageId: "identicalTitle",
              data: { kind: registration.kind, title },
            });
          },
        };
      },
    },
  },
});
````

## .oxlint-plugins/__fixtures__/bun-test-hygiene.fixture.ts

````ts
// Passive regression fixture for `bun-test-hygiene`.
//
// Each `oxlint-disable-next-line` suppresses a case the rule MUST flag; if the
// rule regresses, the unused directive fails the fixture harness. A blank line
// separates each case description from a disabled-test case, because a
// comment directly above a `.skip` counts as its reason.

import * as bun from "bun";
import { SQL, SQL as PgClient } from "bun";
import * as bt from "bun:test";
import {
  describe,
  expect,
  expect as assertThat,
  it,
  test as check,
  test,
  xdescribe,
  xit,
  xtest,
} from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql";

declare const local: { only: (title: string, fn: () => void) => void };
declare const flag: string | undefined;
const noop = () => undefined;
const table = [[1], [2]];

// --- no-focused-tests ---

// named import
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
test.only("focused test", noop);
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
it.only("focused it", noop);
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
describe.only("focused block", noop);
// computed member
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests, typescript/dot-notation -- the computed form is the case under test
test["only"]("computed focus", noop);
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests, typescript/dot-notation -- the computed form is the case under test
test[`only`]("computed template focus", noop);
// aliased import
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
check.only("aliased focus", noop);
// namespace import
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
bt.test.only("namespace focus", noop);
// chained after a modifier call, and before `.each`
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
test.if(true).only("conditional focus", noop);
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
test.only.each(table)("focused table %d", noop);
// oxlint-disable-next-line bun-test-hygiene/no-focused-tests
test.concurrent.only("concurrent focus", noop);
// a local object that is not a test function
// expect-clean: bun-test-hygiene/no-focused-tests
local.only("not a test function", noop);
// expect-clean: bun-test-hygiene/no-focused-tests
test("plain test", noop);

// --- no-disabled-tests ---

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
test.skip("skipped test", noop);

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
it.todo("todo it");

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
describe.skip("skipped block", noop);

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
xtest("x-prefixed test", noop);

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
xit("x-prefixed it", noop);

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
xdescribe("x-prefixed block", noop);

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
bt.it.skip("namespace skip", noop);

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests, typescript/dot-notation -- the computed form is the case under test
check["todo"]("aliased computed todo");

// oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
test.skip.each(table)("skipped table %d", noop);

// Waits on the upstream parser fix; re-enable when it lands.
// expect-clean: bun-test-hygiene/no-disabled-tests
test.skip("skip with a reason above", noop);
// expect-clean: bun-test-hygiene/no-disabled-tests
test.todo("todo with a reason on the same line"); // needs a fixture corpus
// expect-clean: bun-test-hygiene/no-disabled-tests
test.skipIf(flag === "off")("conditional skip", noop);
// expect-clean: bun-test-hygiene/no-disabled-tests
test.todoIf(flag === "off")("conditional todo", noop);

// a disabled registration in a branch, beside the real one with its title
if (flag === undefined) {
  // expect-clean: bun-test-hygiene/no-disabled-tests, bun-test-hygiene/no-identical-title
  describe.skip("branch suite", noop);
} else {
  // expect-clean: bun-test-hygiene/no-disabled-tests, bun-test-hygiene/no-identical-title
  describe("branch suite", noop);
}

// a conditional expression arm
// expect-clean: bun-test-hygiene/no-disabled-tests
const _armed = flag ? test.skip("arm", noop) : undefined;

describe("block with a branch", () => {
  if (flag === undefined) {
    return;
  }

  // oxlint-disable-next-line bun-test-hygiene/no-disabled-tests
  test.skip("inside a block, not a branch", noop);
});

// --- no-identical-title ---

describe("first block", () => {
  test("same title", noop);
  // oxlint-disable-next-line bun-test-hygiene/no-identical-title
  test("same title", noop);
  // oxlint-disable-next-line bun-test-hygiene/no-identical-title
  it(`same title`, noop);
  // a block may share a test's title
  // expect-clean: bun-test-hygiene/no-identical-title
  describe("same title", noop);
  // `.each` titles are format strings
  test.each(table)("row %d", noop);
  // expect-clean: bun-test-hygiene/no-identical-title
  test.each(table)("row %d", noop);
});

describe("second block", () => {
  // the same title in another block
  // expect-clean: bun-test-hygiene/no-identical-title
  test("same title", noop);
});

// oxlint-disable-next-line bun-test-hygiene/no-identical-title
describe("first block", noop);

// --- no-forced-database-drop ---
declare const fixtureDatabaseName: string;
// oxlint-disable-next-line bun-test-hygiene/no-forced-database-drop -- Fixture exercises rejected database teardown.
const _forcedDrop = `DROP DATABASE "${fixtureDatabaseName}" WITH (FORCE)`;
// expect-clean: bun-test-hygiene/no-forced-database-drop
const _normalDrop = "DROP DATABASE IF EXISTS fixture";

// --- no-unmanaged-database-client ---
declare const databaseUrl: string;
declare const openedClient: SQL;

// oxlint-disable-next-line bun-test-hygiene/no-unmanaged-database-client
const _bunClient = new SQL({ url: databaseUrl, max: 1 });
// aliased, namespace member, and the runtime global
// oxlint-disable-next-line bun-test-hygiene/no-unmanaged-database-client
const _aliasedClient = new PgClient(databaseUrl);
// oxlint-disable-next-line bun-test-hygiene/no-unmanaged-database-client
const _namespaceClient = new bun.SQL(databaseUrl);
// oxlint-disable-next-line bun-test-hygiene/no-unmanaged-database-client
const _globalClient = new Bun.SQL(databaseUrl);
// drizzle opening its own client from a URL or a `connection` option
// oxlint-disable-next-line bun-test-hygiene/no-unmanaged-database-client
const _urlDatabase = drizzle(databaseUrl);
// oxlint-disable-next-line bun-test-hygiene/no-unmanaged-database-client
const _connectionDatabase = drizzle({ connection: databaseUrl });
// drizzle wrapping a client opened elsewhere
// expect-clean: bun-test-hygiene/no-unmanaged-database-client
const _wrappedDatabase = drizzle({ client: openedClient });
// a driver error class reached through the client export
// expect-clean: bun-test-hygiene/no-unmanaged-database-client
const _driverError = new SQL.PostgresError("terminating connection", {
  code: "ERR_POSTGRES_SERVER_ERROR",
  errno: "57P01",
  detail: "",
  hint: "",
  severity: "FATAL",
});

// --- no-promise-matchers ---

declare const pending: Promise<number>;
declare const playwrightExpect: (value: unknown) => {
  rejects: { toThrow: () => Promise<void> };
};

// oxlint-disable-next-line bun-test-hygiene/no-promise-matchers
const _rejects = expect(pending).rejects.toThrow("boom");
// oxlint-disable-next-line bun-test-hygiene/no-promise-matchers
const _resolves = expect(pending).resolves.toBe(1);
// aliased import
// oxlint-disable-next-line bun-test-hygiene/no-promise-matchers
const _aliased = assertThat(pending).resolves.toBe(1);
// namespace member
// oxlint-disable-next-line bun-test-hygiene/no-promise-matchers
const _namespace = bt.expect(pending).rejects.toBeInstanceOf(Error);
// computed member
// oxlint-disable-next-line bun-test-hygiene/no-promise-matchers, typescript/dot-notation -- the computed form is the case under test
const _computed = expect(pending)["rejects"].toBeInstanceOf(Error);
// a negation before the promise matcher
// oxlint-disable-next-line bun-test-hygiene/no-promise-matchers
const _negatedRejects = expect(pending).not.rejects.toThrow("boom");
// oxlint-disable-next-line bun-test-hygiene/no-promise-matchers
const _negatedResolves = expect(pending).not.resolves.toBe(2);
// an awaited value
// expect-clean: bun-test-hygiene/no-promise-matchers
const _awaited = async () => expect(await pending).toBe(1);
// a framework whose `expect` is not from `bun:test`
// expect-clean: bun-test-hygiene/no-promise-matchers
const _playwright = playwrightExpect(pending).rejects.toThrow();
````

## .oxlint-plugins/__tests__/bun-test-hygiene.test.ts

(absent)

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
