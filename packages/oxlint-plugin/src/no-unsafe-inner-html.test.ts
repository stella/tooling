/// <reference types="bun-types" />

import type { ESTree, Span } from "@oxlint/plugins";
import { expect, test } from "bun:test";

import noUnsafeInnerHtml from "./no-unsafe-inner-html";

const nodeSpan = (start: number, end: number): Span => ({
  start,
  end,
  range: [start, end],
  loc: { start: { line: 1, column: start }, end: { line: 1, column: end } },
});

const fixtureProgram = (): ESTree.Program => ({
  ...nodeSpan(0, 1),
  type: "Program",
  sourceType: "module",
  body: [],
  comments: [],
  tokens: [],
  parent: null,
});

const withParents = <T extends ESTree.Node>(
  node: T,
  children: readonly (ESTree.Node | null)[],
): T => {
  for (const child of children) {
    if (child !== null) {
      child.parent = node;
    }
  }
  return node;
};

const identifier = (name: string): ESTree.IdentifierReference => ({
  ...nodeSpan(0, 1),
  type: "Identifier",
  name,
  parent: fixtureProgram(),
});

const member = (
  object: ESTree.Expression,
  property: ESTree.IdentifierName,
): ESTree.StaticMemberExpression =>
  withParents(
    {
      ...nodeSpan(0, 1),
      type: "MemberExpression",
      object,
      property,
      computed: false,
      optional: false,
      parent: fixtureProgram(),
    } satisfies ESTree.StaticMemberExpression,
    [object, property],
  );

const literal = (value: string | null): ESTree.StringLiteral | ESTree.NullLiteral =>
  value === null
    ? {
        ...nodeSpan(0, 1),
        type: "Literal",
        value: null,
        raw: "null",
        parent: fixtureProgram(),
      }
    : {
        ...nodeSpan(0, 1),
        type: "Literal",
        value,
        raw: null,
        parent: fixtureProgram(),
      };

const call = (
  callee: ESTree.Expression,
  args: ESTree.Argument[],
): ESTree.CallExpression =>
  withParents(
    {
      ...nodeSpan(0, 1),
      type: "CallExpression",
      callee,
      arguments: args,
      optional: false,
      parent: fixtureProgram(),
    } satisfies ESTree.CallExpression,
    [callee, ...args],
  );

const array = ({ elements }: Pick<ESTree.ArrayExpression, "elements">) =>
  withParents(
    {
      ...nodeSpan(0, 1),
      type: "ArrayExpression",
      elements,
      parent: fixtureProgram(),
    } satisfies ESTree.ArrayExpression,
    elements,
  );

const objectLiteral = ({
  properties,
}: Pick<ESTree.ObjectExpression, "properties">) =>
  withParents(
    {
      ...nodeSpan(0, 1),
      type: "ObjectExpression",
      properties,
      parent: fixtureProgram(),
    } satisfies ESTree.ObjectExpression,
    properties,
  );

const spread = ({ argument }: Pick<ESTree.SpreadElement, "argument">) =>
  withParents(
    {
      ...nodeSpan(0, 1),
      type: "SpreadElement",
      argument,
      parent: fixtureProgram(),
    } satisfies ESTree.SpreadElement,
    [argument],
  );

const objectProperty = ({
  key,
  value,
  computed,
}: Pick<ESTree.ObjectProperty, "key" | "value" | "computed">) =>
  withParents(
    {
      ...nodeSpan(0, 1),
      type: "Property",
      kind: "init",
      method: false,
      shorthand: false,
      computed,
      key,
      value,
      parent: fixtureProgram(),
    } satisfies ESTree.ObjectProperty,
    [key, value],
  );

const template = ({
  expressions,
  quasis,
}: Pick<ESTree.TemplateLiteral, "expressions" | "quasis">) =>
  withParents(
    {
      ...nodeSpan(0, 1),
      type: "TemplateLiteral",
      expressions,
      quasis,
      parent: fixtureProgram(),
    } satisfies ESTree.TemplateLiteral,
    [...expressions, ...quasis],
  );

const templateElement = ({
  value,
}: {
  value: { cooked: string };
}): ESTree.TemplateElement => ({
  ...nodeSpan(0, 1),
  type: "TemplateElement",
  value: { cooked: value.cooked, raw: value.cooked },
  tail: true,
  parent: fixtureProgram(),
});

const getRule = () => {
  const rule = noUnsafeInnerHtml.rules["no-unsafe-inner-html"];
  if (rule === undefined) {
    throw new Error("expected the no-unsafe-inner-html rule");
  }
  return rule;
};

const flushProgram = (visitor: object, program: ESTree.Program): void => {
  const onProgramExit = Reflect.get(visitor, "Program:exit");
  if (typeof onProgramExit !== "function") {
    throw new Error("expected a Program:exit visitor");
  }
  onProgramExit(program);
};

// el.innerHTML = sanitizeHtml(); with the same parent links Oxlint supplies.
const sanitizerAssignment = (): {
  assignment: ESTree.AssignmentExpression;
  program: ESTree.Program;
} => {
  const left: ESTree.StaticMemberExpression = {
    ...nodeSpan(0, 12),
    type: "MemberExpression",
    computed: false,
    optional: false,
    object: {
      ...nodeSpan(0, 2),
      type: "Identifier",
      name: "el",
      get parent() {
        return left;
      },
    },
    property: {
      ...nodeSpan(3, 12),
      type: "Identifier",
      name: "innerHTML",
      get parent() {
        return left;
      },
    },
    get parent() {
      return assignment;
    },
  };
  const right: ESTree.CallExpression = {
    ...nodeSpan(15, 29),
    type: "CallExpression",
    optional: false,
    arguments: [],
    callee: {
      ...nodeSpan(15, 27),
      type: "Identifier",
      name: "sanitizeHtml",
      get parent() {
        return right;
      },
    },
    get parent() {
      return assignment;
    },
  };
  const assignment: ESTree.AssignmentExpression = {
    ...nodeSpan(0, 29),
    type: "AssignmentExpression",
    operator: "=",
    left,
    right,
    get parent() {
      return statement;
    },
  };
  const statement: ESTree.ExpressionStatement = {
    ...nodeSpan(0, 30),
    type: "ExpressionStatement",
    expression: assignment,
    get parent() {
      return program;
    },
  };
  const program: ESTree.Program = {
    ...nodeSpan(0, 30),
    type: "Program",
    sourceType: "module",
    body: [statement],
    comments: [],
    tokens: [],
    parent: null,
  };
  return { assignment, program };
};

const runCallVisitor = (node: ESTree.CallExpression): unknown[] => {
  const program = fixtureProgram();
  const statement: ESTree.ExpressionStatement = {
    ...nodeSpan(0, 1),
    type: "ExpressionStatement",
    expression: node,
    parent: program,
  };
  program.body.push(statement);
  node.parent = statement;
  const rule = getRule();
  if (!("createOnce" in rule) || typeof rule.createOnce !== "function") {
    throw new Error("expected an Oxlint createOnce rule");
  }
  const diagnostics: unknown[] = [];
  const context = Object.create(null);
  Object.defineProperties(context, {
    options: { value: [], writable: true, configurable: true },
    sourceCode: {
      value: { getScope: () => ({ set: new Map(), upper: null }) },
    },
    report: {
      value: (diagnostic: unknown) => diagnostics.push(diagnostic),
    },
  });
  const visitor = rule.createOnce(context);
  visitor.before?.();
  const onCall = Reflect.get(visitor, "CallExpression");
  if (typeof onCall !== "function") {
    throw new Error("expected a CallExpression visitor");
  }
  onCall(node);
  flushProgram(visitor, program);
  return diagnostics;
};

test("sanitizer policy schema rejects unknown modes and option keys", () => {
  const rule = getRule();
  const schema = rule.meta?.schema;
  if (schema === undefined) {
    throw new Error("expected a sanitizer policy schema");
  }
  expect(schema).toEqual([
    {
      type: "object",
      properties: {
        sanitizerPolicy: {
          type: "string",
          enum: ["allowlist", "provenance"],
        },
      },
      additionalProperties: false,
    },
  ]);
});

test("sanitizer policy follows options set before each file", () => {
  const rule = getRule();
  if (!("createOnce" in rule) || typeof rule.createOnce !== "function") {
    throw new Error("expected an Oxlint createOnce rule");
  }
  const diagnostics: unknown[] = [];
  const context = Object.create(null);
  Object.defineProperties(context, {
    options: { value: null, writable: true, configurable: true },
    report: {
      value: (diagnostic: unknown) => diagnostics.push(diagnostic),
    },
  });

  // createOnce runs once with options still null; the compat wrapper supplies
  // the current file's options immediately before calling `before`.
  const visitor = rule.createOnce(context);
  const { assignment, program } = sanitizerAssignment();
  const onAssignment = Reflect.get(visitor, "AssignmentExpression");
  if (typeof onAssignment !== "function") {
    throw new Error("expected an AssignmentExpression visitor");
  }

  context.options = [];
  visitor.before?.();
  onAssignment(assignment);
  flushProgram(visitor, program);
  expect(diagnostics).toHaveLength(0);

  context.options = [{ sanitizerPolicy: "provenance" }];
  visitor.before?.();
  onAssignment(assignment);
  flushProgram(visitor, program);
  expect(diagnostics).toHaveLength(1);

  context.options = [{ sanitizerPolicy: "allowlist" }];
  visitor.before?.();
  onAssignment(assignment);
  flushProgram(visitor, program);
  expect(diagnostics).toHaveLength(1);
});

test("apply forwards static arrays and fails closed for opaque HTML arguments", () => {
  const insertAdjacentHtml = member(
    identifier("element"),
    identifier("insertAdjacentHTML"),
  );
  const applyInsert = (argumentsValue: ESTree.Expression) =>
    call(member(insertAdjacentHtml, identifier("apply")), [
      identifier("element"),
      argumentsValue,
    ]);

  expect(
    runCallVisitor(
      applyInsert(
        array({
          elements: [literal("beforeend"), identifier("rawHtml")],
        }),
      ),
    ),
  ).toHaveLength(1);
  expect(
    runCallVisitor(
      applyInsert(
        array({
          elements: [literal("beforeend"), literal("<b>Static</b>")],
        }),
      ),
    ),
  ).toHaveLength(0);
  expect(
    runCallVisitor(applyInsert(identifier("unknownArguments"))),
  ).toHaveLength(1);
  expect(
    runCallVisitor(
      applyInsert(
        array({
          elements: [null, literal("<b>Static</b>"), identifier("rawHtml")],
        }),
      ),
    ),
  ).toHaveLength(0);
  expect(
    runCallVisitor(
      applyInsert(
        array({
          elements: [
            spread({ argument: identifier("arguments") }),
          ],
        }),
      ),
    ),
  ).toHaveLength(1);

  const documentWrite = member(identifier("document"), identifier("write"));
  const applyWrite = (argumentsValue: ESTree.Expression) =>
    call(member(documentWrite, identifier("apply")), [
      identifier("document"),
      argumentsValue,
    ]);
  expect(
    runCallVisitor(
      applyWrite(
        array({ elements: [identifier("rawHtml")] }),
      ),
    ),
  ).toHaveLength(1);
  expect(
    runCallVisitor(
      applyWrite(
        array({ elements: [literal("<p>Static</p>")] }),
      ),
    ),
  ).toHaveLength(0);
  expect(
    runCallVisitor(applyWrite(identifier("unknownArguments"))),
  ).toHaveLength(1);
  expect(runCallVisitor(applyWrite(literal(null)))).toHaveLength(0);
  expect(runCallVisitor(applyWrite(identifier("undefined")))).toHaveLength(0);
});

test("Object.assign checks opaque sources only for known DOM targets", () => {
  const createElement = call(
    member(identifier("document"), identifier("createElement")),
    [literal("div")],
  );
  const assign = (target: ESTree.Expression, source: ESTree.Expression) =>
    call(member(identifier("Object"), identifier("assign")), [target, source]);
  const applyAssign = (argumentsValue: ESTree.Expression) =>
    call(
      member(
        member(identifier("Object"), identifier("assign")),
        identifier("apply"),
      ),
      [identifier("Object"), argumentsValue],
    );

  expect(
    runCallVisitor(assign(createElement, identifier("payload"))),
  ).toHaveLength(1);
  expect(
    runCallVisitor(
      assign(
        createElement,
        objectLiteral({
          properties: [
            spread({ argument: identifier("payload") }),
          ],
        }),
      ),
    ),
  ).toHaveLength(1);
  expect(
    runCallVisitor(assign(identifier("config"), identifier("payload"))),
  ).toHaveLength(0);
  expect(
    runCallVisitor(
      applyAssign(
        array({
          elements: [createElement, identifier("payload")],
        }),
      ),
    ),
  ).toHaveLength(1);
  expect(
    runCallVisitor(
      applyAssign(
        array({
          elements: [
            createElement,
            spread({ argument: identifier("sources") }),
          ],
        }),
      ),
    ),
  ).toHaveLength(1);
  expect(
    runCallVisitor(
      applyAssign(
        array({
          elements: [
            createElement,
            objectLiteral({
              properties: [
                objectProperty({
                  computed: false,
                  key: identifier("textContent"),
                  value: identifier("text"),
                }),
              ],
            }),
          ],
        }),
      ),
    ),
  ).toHaveLength(0);
  expect(
    runCallVisitor(applyAssign(identifier("opaqueArguments"))),
  ).toHaveLength(0);
  expect(
    runCallVisitor(
      assign(
        createElement,
        objectLiteral({
          properties: [
            objectProperty({
              computed: false,
              key: identifier("textContent"),
              value: identifier("text"),
            }),
          ],
        }),
      ),
    ),
  ).toHaveLength(0);
  expect(
    runCallVisitor(
      assign(
        createElement,
        objectLiteral({
          properties: [
            objectProperty({
              computed: true,
              key: identifier("dynamicKey"),
              value: identifier("dynamicValue"),
            }),
          ],
        }),
      ),
    ),
  ).toHaveLength(1);
  expect(
    runCallVisitor(
      assign(
        createElement,
        objectLiteral({
          properties: [
            objectProperty({
              computed: true,
              key: template({
                expressions: [],
                quasis: [
                  templateElement({
                    value: { cooked: "innerHTML" },
                  }),
                ],
              }),
              value: literal("<b>Static</b>"),
            }),
          ],
        }),
      ),
    ),
  ).toHaveLength(0);
});
