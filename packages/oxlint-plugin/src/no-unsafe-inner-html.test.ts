import type { ESTree, Span } from "@oxlint/plugins";
import { expect, test } from "bun:test";

import noUnsafeInnerHtml from "./no-unsafe-inner-html";

const astNode = (type: string, properties: Record<string, unknown> = {}) => ({
  type,
  range: [0, 1],
  ...properties,
});

const identifier = (name: string) => astNode("Identifier", { name });

const member = (object: unknown, property: unknown) =>
  astNode("MemberExpression", { object, property, computed: false });

const literal = (value: unknown) => astNode("Literal", { value });

const getRule = () => {
  const rule = noUnsafeInnerHtml.rules["no-unsafe-inner-html"];
  if (rule === undefined) {
    throw new Error("expected the no-unsafe-inner-html rule");
  }
  return rule;
};

const call = (callee: unknown, args: unknown[]) =>
  astNode("CallExpression", {
    callee,
    arguments: args,
    loc: { start: { line: 1 } },
  });

const nodeSpan = (start: number, end: number): Span => ({
  start,
  end,
  range: [start, end],
  loc: { start: { line: 1, column: start }, end: { line: 1, column: end } },
});

// el.innerHTML = sanitizeHtml(); with the same parent links Oxlint supplies.
const sanitizerAssignment = (): ESTree.AssignmentExpression => {
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
  return assignment;
};

const runCallVisitor = (node: unknown): unknown[] => {
  const rule = getRule();
  if (!("createOnce" in rule) || typeof rule.createOnce !== "function") {
    throw new Error("expected an Oxlint createOnce rule");
  }
  const diagnostics: unknown[] = [];
  const context = Object.create(null);
  Object.defineProperties(context, {
    options: { value: [], writable: true, configurable: true },
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
  const assignment = sanitizerAssignment();
  const onAssignment = Reflect.get(visitor, "AssignmentExpression");
  if (typeof onAssignment !== "function") {
    throw new Error("expected an AssignmentExpression visitor");
  }

  context.options = [];
  visitor.before?.();
  onAssignment(assignment);
  expect(diagnostics).toHaveLength(0);

  context.options = [{ sanitizerPolicy: "provenance" }];
  visitor.before?.();
  onAssignment(assignment);
  expect(diagnostics).toHaveLength(1);

  context.options = [{ sanitizerPolicy: "allowlist" }];
  visitor.before?.();
  onAssignment(assignment);
  expect(diagnostics).toHaveLength(1);
});

test("apply forwards static arrays and fails closed for opaque HTML arguments", () => {
  const insertAdjacentHtml = member(
    identifier("element"),
    identifier("insertAdjacentHTML"),
  );
  const applyInsert = (argumentsValue: unknown) =>
    call(member(insertAdjacentHtml, identifier("apply")), [
      identifier("element"),
      argumentsValue,
    ]);

  expect(
    runCallVisitor(
      applyInsert(
        astNode("ArrayExpression", {
          elements: [literal("beforeend"), identifier("rawHtml")],
        }),
      ),
    ),
  ).toHaveLength(1);
  expect(
    runCallVisitor(
      applyInsert(
        astNode("ArrayExpression", {
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
        astNode("ArrayExpression", {
          elements: [null, literal("<b>Static</b>"), identifier("rawHtml")],
        }),
      ),
    ),
  ).toHaveLength(0);
  expect(
    runCallVisitor(
      applyInsert(
        astNode("ArrayExpression", {
          elements: [
            astNode("SpreadElement", { argument: identifier("arguments") }),
          ],
        }),
      ),
    ),
  ).toHaveLength(1);

  const documentWrite = member(identifier("document"), identifier("write"));
  const applyWrite = (argumentsValue: unknown) =>
    call(member(documentWrite, identifier("apply")), [
      identifier("document"),
      argumentsValue,
    ]);
  expect(
    runCallVisitor(
      applyWrite(
        astNode("ArrayExpression", { elements: [identifier("rawHtml")] }),
      ),
    ),
  ).toHaveLength(1);
  expect(
    runCallVisitor(
      applyWrite(
        astNode("ArrayExpression", { elements: [literal("<p>Static</p>")] }),
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
  const assign = (target: unknown, source: unknown) =>
    call(member(identifier("Object"), identifier("assign")), [target, source]);
  const applyAssign = (argumentsValue: unknown) =>
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
        astNode("ObjectExpression", {
          properties: [
            astNode("SpreadElement", { argument: identifier("payload") }),
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
        astNode("ArrayExpression", {
          elements: [createElement, identifier("payload")],
        }),
      ),
    ),
  ).toHaveLength(1);
  expect(
    runCallVisitor(
      applyAssign(
        astNode("ArrayExpression", {
          elements: [
            createElement,
            astNode("SpreadElement", { argument: identifier("sources") }),
          ],
        }),
      ),
    ),
  ).toHaveLength(1);
  expect(
    runCallVisitor(
      applyAssign(
        astNode("ArrayExpression", {
          elements: [
            createElement,
            astNode("ObjectExpression", {
              properties: [
                astNode("Property", {
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
        astNode("ObjectExpression", {
          properties: [
            astNode("Property", {
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
        astNode("ObjectExpression", {
          properties: [
            astNode("Property", {
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
        astNode("ObjectExpression", {
          properties: [
            astNode("Property", {
              computed: true,
              key: astNode("TemplateLiteral", {
                expressions: [],
                quasis: [
                  astNode("TemplateElement", {
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
