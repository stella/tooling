import { expect, test } from "bun:test";

import noUnsafeInnerHtml from "./no-unsafe-inner-html";

test("sanitizer policy schema rejects unknown modes and option keys", () => {
  expect(noUnsafeInnerHtml.rules["no-unsafe-inner-html"].meta?.schema).toEqual([
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
  const rule = noUnsafeInnerHtml.rules["no-unsafe-inner-html"];
  if (rule.createOnce === undefined) {
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
  const assignment = {
    type: "AssignmentExpression",
    range: [0, 10],
    left: {
      type: "MemberExpression",
      range: [0, 8],
      computed: false,
      object: { type: "Identifier", range: [0, 1], name: "el" },
      property: { type: "Identifier", range: [3, 8], name: "innerHTML" },
    },
    right: {
      type: "CallExpression",
      range: [9, 20],
      loc: { start: { line: 1 } },
      callee: { type: "Identifier", range: [9, 20], name: "sanitizeHtml" },
      arguments: [],
    },
  };
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
