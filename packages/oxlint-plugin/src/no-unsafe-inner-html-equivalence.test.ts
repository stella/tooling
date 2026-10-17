/// <reference types="bun-types" />

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";
import type { ESTree } from "@oxlint/plugins";
import {
  DOCUMENT_WRITE_METHODS,
  DOM_ELEMENT_PRODUCERS,
  HTML_ATTRIBUTE_SINKS,
  REACT_ELEMENT_FACTORIES,
  REACT_HTML_PROPS,
} from "./no-unsafe-inner-html.ts";
import { EXPRESSION_WRAPPER_TYPES, unwrapExpression } from "./utils.ts";

const repositoryRoot = resolve(import.meta.dir, "../../../");
const fixtureRoot = join(repositoryRoot, "packages/oxlint-plugin/fixtures");
const rulePath = join(
  repositoryRoot,
  "packages/oxlint-plugin/src/no-unsafe-inner-html.ts",
);
const ruleId = "no-unsafe-inner-html/no-unsafe-inner-html";
const invalidDirective = new RegExp(
  `//\\s*oxlint-disable(?:-next-line|-line)?\\s+${ruleId.replaceAll("/", "\\/")}\\b`,
  "gu",
);
const cleanMarker = new RegExp(`expect-clean:\\s*${ruleId.replaceAll("/", "\\/")}\\b`, "gu");
type ExpressionBearingNode = Extract<ESTree.Node, { expression: ESTree.Node }>;
const expressionWrapperPolicies = {
  ArrayExpression: {
    disposition: "preserve",
    reason: "array construction changes the value",
  },
  ArrowFunctionExpression: {
    disposition: "preserve",
    reason: "function creation is a runtime operation",
  },
  AssignmentExpression: {
    disposition: "preserve",
    reason: "assignment mutates state",
  },
  AwaitExpression: {
    disposition: "preserve",
    reason: "await changes control flow and value timing",
  },
  BinaryExpression: {
    disposition: "preserve",
    reason: "binary operation computes a value",
  },
  CallExpression: {
    disposition: "preserve",
    reason: "call executes a function",
  },
  ChainExpression: {
    disposition: "peel",
    reason: "chain syntax preserves the wrapped value",
  },
  ClassDeclaration: {
    disposition: "preserve",
    reason: "class declaration creates a binding",
  },
  ClassExpression: {
    disposition: "preserve",
    reason: "class creation is a runtime operation",
  },
  ConditionalExpression: {
    disposition: "preserve",
    reason: "conditional expression selects a branch",
  },
  FunctionDeclaration: {
    disposition: "preserve",
    reason: "function declaration creates a binding",
  },
  FunctionExpression: {
    disposition: "preserve",
    reason: "function creation is a runtime operation",
  },
  Identifier: {
    disposition: "preserve",
    reason: "identifier resolves a binding",
  },
  ImportExpression: {
    disposition: "preserve",
    reason: "dynamic import executes a module load",
  },
  JSXElement: {
    disposition: "preserve",
    reason: "JSX construction creates an element",
  },
  JSXFragment: {
    disposition: "preserve",
    reason: "JSX construction creates a fragment",
  },
  LogicalExpression: {
    disposition: "preserve",
    reason: "logical expression selects a value",
  },
  MemberExpression: {
    disposition: "preserve",
    reason: "member access reads a property",
  },
  MetaProperty: {
    disposition: "preserve",
    reason: "meta property supplies runtime context",
  },
  NewExpression: {
    disposition: "preserve",
    reason: "constructor call creates a value",
  },
  Literal: {
    disposition: "preserve",
    reason: "literal is the value itself",
  },
  ObjectExpression: {
    disposition: "preserve",
    reason: "object construction changes the value",
  },
  ParenthesizedExpression: {
    disposition: "peel",
    reason: "parentheses preserve the wrapped value",
  },
  SequenceExpression: {
    disposition: "preserve",
    reason: "sequence expression executes preceding expressions",
  },
  Super: {
    disposition: "preserve",
    reason: "super is a runtime receiver",
  },
  TaggedTemplateExpression: {
    disposition: "preserve",
    reason: "tagged template executes a function",
  },
  TemplateLiteral: {
    disposition: "preserve",
    reason: "template interpolations compute a value",
  },
  ThisExpression: {
    disposition: "preserve",
    reason: "this resolves a runtime receiver",
  },
  TSDeclareFunction: {
    disposition: "preserve",
    reason: "declaration has no runtime expression to peel",
  },
  TSEmptyBodyFunctionExpression: {
    disposition: "preserve",
    reason: "function signature has no runtime expression to peel",
  },
  TSAsExpression: {
    disposition: "peel",
    reason: "a TypeScript assertion preserves runtime value",
  },
  TSInstantiationExpression: {
    disposition: "peel",
    reason: "type arguments do not change runtime value",
  },
  TSNonNullExpression: {
    disposition: "peel",
    reason: "the non-null assertion preserves runtime value",
  },
  TSSatisfiesExpression: {
    disposition: "peel",
    reason: "satisfies only checks a static type",
  },
  TSTypeAssertion: {
    disposition: "peel",
    reason: "a TypeScript assertion preserves runtime value",
  },
  UnaryExpression: {
    disposition: "preserve",
    reason: "unary operation computes a value",
  },
  UpdateExpression: {
    disposition: "preserve",
    reason: "update operation mutates state",
  },
  V8IntrinsicExpression: {
    disposition: "preserve",
    reason: "intrinsic expression executes runtime behavior",
  },
  YieldExpression: {
    disposition: "preserve",
    reason: "yield changes generator control flow",
  },
} as const satisfies Readonly<
  Record<
    ESTree.Expression["type"],
    { disposition: "peel" | "preserve"; reason: string }
  >
>;
type ExpressionCarrierKind = Exclude<
  ExpressionBearingNode["type"],
  (typeof EXPRESSION_WRAPPER_TYPES)[number]
>;
const expressionCarrierPolicies = {
  Decorator: "decorator owns a semantic expression",
  ExpressionStatement: "statement owns its executed expression",
  JSXExpressionContainer: "JSX owns its embedded expression",
  JSXSpreadChild: "JSX child owns its spread expression",
  TSClassImplements: "class declaration owns its implemented type expression",
  TSExportAssignment: "export declaration owns its value expression",
  TSExternalModuleReference: "import declaration owns its module expression",
  TSInterfaceHeritage: "interface declaration owns its heritage expression",
} as const satisfies Readonly<Record<ExpressionCarrierKind, string>>;

type MemberEdit = {
  kind: "member";
  file: string;
  objectEnd: number;
  propertyStart: number;
  propertyEnd: number;
  propertyName: string;
  optional: boolean;
};

type AliasEdit = {
  kind: "alias";
  file: string;
  callStart: number;
  callEnd: number;
  calleeEnd: number;
  targetStart: number;
  targetEnd: number;
};

type SpreadEdit = {
  kind: "spread";
  file: string;
  callStart: number;
  callEnd: number;
  calleeEnd: number;
};

type JsxEdit = {
  kind: "jsx";
  file: string;
  start: number;
  end: number;
  reactText: string;
  jsxText: string;
  elementCount: number;
};

type JsxInventoryEdit = {
  kind: "jsx-inventory";
  file: string;
  elementCount: number;
};

type DomTarget = { start: number; end: number };
type DomTargetInventoryEdit = {
  kind: "dom-target-inventory";
  file: string;
  targets: DomTarget[];
};
type ExpressionWrapperInventoryEdit = {
  kind: "expression-wrapper-inventory";
  file: string;
  types: string[];
};

type Edit =
  | MemberEdit
  | AliasEdit
  | SpreadEdit
  | JsxEdit
  | JsxInventoryEdit
  | DomTargetInventoryEdit
  | ExpressionWrapperInventoryEdit;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEdit = (value: unknown): value is Edit => {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "member") {
    return (
      typeof value.file === "string" &&
      typeof value.objectEnd === "number" &&
      typeof value.propertyStart === "number" &&
      typeof value.propertyEnd === "number" &&
      typeof value.propertyName === "string" &&
      typeof value.optional === "boolean"
    );
  }
  if (value.kind === "alias") {
    return (
      typeof value.file === "string" &&
      typeof value.callStart === "number" &&
      typeof value.callEnd === "number" &&
      typeof value.calleeEnd === "number" &&
      typeof value.targetStart === "number" &&
      typeof value.targetEnd === "number"
    );
  }
  if (value.kind === "jsx") {
    return (
      typeof value.file === "string" &&
      typeof value.start === "number" &&
      typeof value.end === "number" &&
      typeof value.reactText === "string" &&
      typeof value.jsxText === "string" &&
      typeof value.elementCount === "number"
    );
  }
  if (value.kind === "jsx-inventory") {
    return (
      typeof value.file === "string" &&
      typeof value.elementCount === "number"
    );
  }
  if (value.kind === "dom-target-inventory") {
    return (
      typeof value.file === "string" &&
      Array.isArray(value.targets) &&
      value.targets.every(
        (target) =>
          isRecord(target) &&
          typeof target.start === "number" &&
          typeof target.end === "number",
      )
    );
  }
  if (value.kind === "expression-wrapper-inventory") {
    return (
      typeof value.file === "string" &&
      Array.isArray(value.types) &&
      value.types.every((type) => typeof type === "string")
    );
  }
  return (
    value.kind === "spread" &&
    typeof value.file === "string" &&
    typeof value.callStart === "number" &&
    typeof value.callEnd === "number" &&
    typeof value.calleeEnd === "number"
  );
};

const htmlMethodNames = [
  "createContextualFragment",
  "insertAdjacentHTML",
  "setHTMLUnsafe",
  ...HTML_ATTRIBUTE_SINKS.map(({ name }) => name),
  ...DOCUMENT_WRITE_METHODS,
];
const collectorPlugin = String.raw`
const htmlMethods = new Set(${JSON.stringify(htmlMethodNames)});
const elementFactories = new Set([
  "createElement",
  "jsx",
  "jsxs",
  "jsxDEV",
]);
const staticName = (node) => {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
};
const methodName = (callee) => {
  if (callee?.type !== "MemberExpression") return null;
  const name = staticName(callee.property);
  if (name === "call" || name === "apply") return methodName(callee.object);
  return name;
};
const jsxKinds = new Set(["JSXElement", "JSXFragment"]);
const jsxText = (context, node) => context.sourceCode.getText(node);
const jsxTagName = (context, node) => {
  const text = jsxText(context, node);
  return node.type === "JSXNamespacedName" ||
    (node.type === "JSXIdentifier" && /^[a-z]/u.test(node.name))
    ? JSON.stringify(text)
    : text;
};
const jsxAttributeName = (context, node) => {
  const text = jsxText(context, node);
  return JSON.stringify(text);
};
const applySourceEdits = (source, edits, base) => {
  let output = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    output =
      output.slice(0, edit.start - base) +
      edit.text +
      output.slice(edit.end - base);
  }
  return output;
};
const renderExpression = (context, node, mode) => {
  if (jsxKinds.has(node.type)) return renderJsx(context, node, mode);
  const source = jsxText(context, node);
  const replacements = [];
  let elementCount = 0;
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (jsxKinds.has(value.type)) {
      const rendered = renderJsx(context, value, mode);
      replacements.push({
        start: value.range[0],
        end: value.range[1],
        text: rendered.text,
      });
      elementCount += rendered.elementCount;
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "parent" && key !== "loc" && key !== "range") visit(child);
    }
  };
  for (const [key, value] of Object.entries(node)) {
    if (key !== "parent" && key !== "loc" && key !== "range") visit(value);
  }
  return {
    text: applySourceEdits(source, replacements, node.range[0]),
    elementCount,
  };
};
const renderJsx = (context, node, mode) => {
  const isElement = node.type === "JSXElement";
  const opening = isElement ? node.openingElement : null;
  const name = isElement ? jsxTagName(context, opening.name) : "React.Fragment";
  const properties = [];
  let elementCount = isElement ? 1 : 0;
  if (isElement) {
    for (const attribute of opening.attributes) {
      if (attribute.type === "JSXSpreadAttribute") {
        const spreadValue = renderExpression(context, attribute.argument, mode);
        properties.push("..." + spreadValue.text);
        elementCount += spreadValue.elementCount;
        continue;
      }
      let value = "true";
      if (attribute.value?.type === "Literal") {
        value = JSON.stringify(attribute.value.value);
      } else if (attribute.value?.type === "JSXExpressionContainer") {
        const expression = renderExpression(
          context,
          attribute.value.expression,
          mode,
        );
        value = "(" + expression.text + ")";
        elementCount += expression.elementCount;
      } else if (attribute.value !== null && attribute.value !== undefined) {
        throw new Error("Unsupported JSX attribute value: " + attribute.value.type);
      }
      properties.push(jsxAttributeName(context, attribute.name) + ": " + value);
    }
  }
  const children = [];
  for (const child of node.children) {
    if (child.type === "JSXText") {
      if (child.value !== "") children.push(JSON.stringify(child.value));
    } else if (child.type === "JSXExpressionContainer") {
      if (child.expression.type === "JSXEmptyExpression") {
        const comment = context.sourceCode.text.slice(
          child.range[0] + 1,
          child.range[1] - 1,
        );
        children.push("null " + comment + "\n");
      } else {
        const expression = renderExpression(context, child.expression, mode);
        children.push(expression.text);
        elementCount += expression.elementCount;
      }
    } else if (child.type === "JSXSpreadChild") {
      const expression = renderExpression(context, child.expression, mode);
      children.push("..." + expression.text);
      elementCount += expression.elementCount;
    } else if (jsxKinds.has(child.type)) {
      const rendered = renderJsx(context, child, mode);
      children.push(rendered.text);
      elementCount += rendered.elementCount;
    }
  }
  const props = properties.length === 0 ? null : "{" + properties.join(", ") + "}";
  if (mode === "react") {
    const args = [name, props ?? "null", ...children];
    return {
      text: "React.createElement(" + args.join(", ") + ")",
      elementCount,
    };
  }
  const jsxProperties = properties.slice();
  if (children.length > 0) {
    jsxProperties.push(
      "children: " +
        (children.length === 1 ? children[0] : "[" + children.join(", ") + "]"),
    );
  }
  return {
    text: "jsx(" + name + ", {" + jsxProperties.join(", ") + "})",
    elementCount,
  };
};
const hasJsxAncestor = (node) => {
  let parent = node.parent;
  while (parent) {
    if (jsxKinds.has(parent.type)) return true;
    parent = parent.parent;
  }
  return false;
};
const report = (context, node, edit) =>
  context.report({ node, message: "EQUIVALENCE:" + JSON.stringify(edit) });

export default {
  rules: {
    edits: {
      meta: { type: "problem" },
      create(context) {
        let visitedJsxElements = 0;
        return {
          MemberExpression(node) {
            if (node.computed || node.property?.type !== "Identifier") return;
            report(context, node, {
              kind: "member",
              file: context.filename,
              objectEnd: node.object.range[1],
              propertyStart: node.property.range[0],
              propertyEnd: node.property.range[1],
              propertyName: node.property.name,
              optional: node.optional === true,
            });
          },
          CallExpression(node) {
            if (node.optional === true) return;
            const name =
              node.callee?.type === "MemberExpression"
                ? methodName(node.callee)
                : node.callee?.type === "Identifier"
                  ? node.callee.name
                  : null;
            const isHtmlSink =
              node.callee?.type === "MemberExpression" &&
              htmlMethods.has(name);
            const isElementFactory =
              (node.callee?.type === "Identifier" &&
                elementFactories.has(node.callee.name)) ||
              (node.callee?.type === "MemberExpression" &&
                name === "createElement" &&
                node.callee.object?.type === "Identifier" &&
                node.callee.object.name === "React");
            if (
              (!isHtmlSink && !isElementFactory) ||
              node.arguments.length === 0
            ) {
              return;
            }
            report(context, node, {
              kind: "spread",
              file: context.filename,
              callStart: node.range[0],
              callEnd: node.range[1],
              calleeEnd: node.callee.range[1],
            });
            if (
              name === "assign" &&
              node.callee?.type === "MemberExpression" &&
              node.callee.object?.type === "Identifier" &&
              node.callee.object.name === "Object" &&
              node.arguments[0].type !== "SpreadElement"
            ) {
              const target = node.arguments[0];
              report(context, node, {
                kind: "alias",
                file: context.filename,
                callStart: node.range[0],
                callEnd: node.range[1],
                calleeEnd: node.callee.range[1],
                targetStart: target.range[0],
                targetEnd: target.range[1],
              });
            }
          },
          JSXElement(node) {
            visitedJsxElements += 1;
            if (hasJsxAncestor(node)) return;
            const react = renderJsx(context, node, "react");
            const jsx = renderJsx(context, node, "jsx");
            if (react.elementCount !== jsx.elementCount) {
              throw new Error("JSX equivalence renderers missed an element");
            }
            report(context, node, {
              kind: "jsx",
              file: context.filename,
              start: node.range[0],
              end: node.range[1],
              reactText: react.text,
              jsxText: jsx.text,
              elementCount: react.elementCount,
            });
          },
          JSXFragment(node) {
            if (hasJsxAncestor(node)) return;
            const react = renderJsx(context, node, "react");
            const jsx = renderJsx(context, node, "jsx");
            if (react.elementCount !== jsx.elementCount) {
              throw new Error("JSX equivalence renderers missed an element");
            }
            report(context, node, {
              kind: "jsx",
              file: context.filename,
              start: node.range[0],
              end: node.range[1],
              reactText: react.text,
              jsxText: jsx.text,
              elementCount: react.elementCount,
            });
          },
          "Program:exit"(node) {
            report(context, node, {
              kind: "jsx-inventory",
              file: context.filename,
              elementCount: visitedJsxElements,
            });
          },
        };
      },
    },
  },
};
`;

const domTargetCollectorPlugin = `import {
  invokedCallee,
  isAstNode,
  isIdentifier,
  memberPropertyName,
  resolveLiteralArraySpreads,
  unwrapExpression,
} from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "packages/oxlint-plugin/src/utils.ts")).href)};
const htmlMethods = new Set(${JSON.stringify(htmlMethodNames)});
` + String.raw`
const htmlProperties = new Set(["innerHTML", "outerHTML", "srcdoc"]);
const staticMemberName = (node) => memberPropertyName(node);
const isObjectAssign = (node) =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  isIdentifier(node.object, "Object") &&
  staticMemberName(node) === "assign";
const objectAssignArguments = (node) => {
  const callee = invokedCallee(node);
  if (!isObjectAssign(callee)) return null;
  const directCallee = unwrapExpression(node.callee);
  const wrapper = directCallee?.type === "MemberExpression"
    ? staticMemberName(directCallee)
    : null;
  const args = resolveLiteralArraySpreads(node.arguments).args;
  if (wrapper === "call") return args.slice(1);
  if (wrapper === "apply") {
    const argsArray = unwrapExpression(args.at(1));
    if (!argsArray || argsArray.type !== "ArrayExpression" || !Array.isArray(argsArray.elements)) {
      return [];
    }
    return resolveLiteralArraySpreads(argsArray.elements).args;
  }
  return args;
};
const ranges = (context) => {
  const targets = new Map();
  const add = (node) => {
    if (!node?.range) return;
    targets.set(node.range[0] + ":" + node.range[1], {
      start: node.range[0],
      end: node.range[1],
    });
  };
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "AssignmentExpression" && node.left?.type === "MemberExpression") {
      if (htmlProperties.has(staticMemberName(node.left))) add(node.left.object);
    }
    if (node.type === "CallExpression") {
      const assignArgs = objectAssignArguments(node);
      if (assignArgs?.length) add(assignArgs[0]);
      const callee = node.callee;
      let method = null;
      let receiver = null;
      let target = callee;
      while (target?.type === "MemberExpression") {
        const name = staticMemberName(target);
        if (name === "call" || name === "apply") {
          target = target.object;
          continue;
        }
        method = name;
        receiver = target.object;
        break;
      }
      if (htmlMethods.has(method)) add(receiver);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent" || key === "loc" || key === "range") continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  };
  visit(context.sourceCode.ast);
  return [...targets.values()].sort((left, right) => left.start - right.start);
};
export default {
  rules: {
    targets: {
      meta: { type: "problem" },
      create(context) {
        return {
          "Program:exit"(node) {
            const visitorKeys = context.sourceCode.visitorKeys;
            if (!visitorKeys) throw new Error("Oxlint did not expose parser visitor keys");
            context.report({
              node,
              message: "EQUIVALENCE:" + JSON.stringify({
                kind: "dom-target-inventory",
                file: context.filename,
                targets: ranges(context),
              }),
            });
            context.report({
              node,
              message: "EQUIVALENCE:" + JSON.stringify({
                kind: "expression-wrapper-inventory",
                file: context.filename,
                types: Object.entries(visitorKeys)
                  .filter(([, keys]) => keys.includes("expression"))
                  .map(([type]) => type)
                  .sort(),
              }),
            });
          },
        };
      },
    },
  },
};
`;

const collectMessages = (value: unknown, messages: string[]): void => {
  if (typeof value === "string") {
    if (value.startsWith("EQUIVALENCE:")) messages.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMessages(item, messages);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectMessages(item, messages);
  }
};

const parseEdits = (stdout: string): Edit[] => {
  const payload: unknown = JSON.parse(stdout);
  const messages: string[] = [];
  collectMessages(payload, messages);
  const edits: Edit[] = [];
  for (const message of messages) {
    const value: unknown = JSON.parse(message.slice("EQUIVALENCE:".length));
    if (!isEdit(value)) throw new Error(`Invalid equivalence edit: ${message}`);
    edits.push({ ...value, file: resolve(repositoryRoot, value.file) });
  }
  return edits;
};

const applyEdits = (
  source: string,
  edits: ReadonlyArray<{ start: number; end: number; text: string }>,
): string => {
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  let output = source;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of ordered) {
    if (edit.end > lastStart) {
      throw new Error(`Overlapping equivalence edits at ${edit.start}:${edit.end}`);
    }
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
    lastStart = edit.start;
  }
  return output;
};

const hasDiagnostics = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasDiagnostics);
  if (!isRecord(value)) return false;
  if (Array.isArray(value.messages) && value.messages.length > 0) return true;
  if (Array.isArray(value.diagnostics) && value.diagnostics.length > 0) return true;
  return Object.values(value).some(hasDiagnostics);
};

type RunOxlintOptions = {
  configPath: string;
  filePaths: readonly string[];
  extraArgs?: readonly string[];
};
const runOxlint = async ({
  configPath,
  filePaths,
  extraArgs = [],
}: RunOxlintOptions): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--bun",
      "oxlint",
      "-c",
      configPath,
      "--format",
      "json",
      ...extraArgs,
      ...filePaths,
    ],
    { cwd: repositoryRoot, stderr: "pipe", stdout: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const memberEdits = (source: string, edits: readonly MemberEdit[]) => {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const edit of edits) {
    const gapEnd = edit.propertyStart;
    const gap = source.slice(edit.objectEnd, gapEnd);
    const operator = edit.optional ? "?." : ".";
    const operatorIndex = gap.lastIndexOf(operator);
    if (operatorIndex < 0) throw new Error("Missing member operator");
    replacements.push({
      start: edit.objectEnd + operatorIndex,
      end: edit.propertyEnd,
      text: `${edit.optional ? "?." : ""}[${JSON.stringify(edit.propertyName)}]`,
    });
  }
  return replacements;
};

const spreadEdits = (
  source: string,
  edits: readonly SpreadEdit[],
): Array<{ start: number; end: number; text: string }> =>
  edits.flatMap((edit) => {
    const openParen = source.indexOf("(", edit.calleeEnd);
    const argsEnd = edit.callEnd - 1;
    if (
      openParen < edit.calleeEnd ||
      openParen >= argsEnd ||
      source[argsEnd] !== ")"
    ) {
      throw new Error("Missing call argument delimiters");
    }
    return [
      { start: openParen + 1, end: openParen + 1, text: "...[" },
      { start: argsEnd, end: argsEnd, text: "]" },
    ];
  });

const wrapperKinds = [
  "non-null",
  "as",
  "satisfies",
  "parentheses",
  "type-assertion",
  "instantiation",
] as const;
type WrapperKind = (typeof wrapperKinds)[number];

const wrapperInsertions = (
  source: string,
  targets: readonly DomTarget[],
  wrapper: WrapperKind,
): Array<{ start: number; end: number; text: string }> => {
  const insertions: Array<{ start: number; end: number; text: string }> = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const key = `${target.start}:${target.end}`;
    if (seen.has(key)) throw new Error(`Duplicate DOM target ${key}`);
    seen.add(key);
    const expression = source.slice(target.start, target.end);
    const prefix = (() => {
      switch (wrapper) {
        case "non-null":
          return "(";
        case "as":
          return "(";
        case "satisfies":
          return "(";
        case "parentheses":
          return "(";
        case "type-assertion":
          return "(<HTMLElement>(";
        case "instantiation":
          return "((";
        default: {
          const exhaustive: never = wrapper;
          throw new Error(`Unknown wrapper: ${exhaustive}`);
        }
      }
    })();
    const suffix = (() => {
      switch (wrapper) {
        case "non-null":
          return ")!";
        case "as":
          return " as HTMLElement)";
        case "satisfies":
          return " satisfies HTMLElement)";
        case "parentheses":
          return ")";
        case "type-assertion":
          return "))";
        case "instantiation":
          return ")<unknown>)";
        default: {
          const exhaustive: never = wrapper;
          throw new Error(`Unknown wrapper: ${exhaustive}`);
        }
      }
    })();
    if (expression.length === 0) throw new Error("Empty DOM target range");
    insertions.push(
      { start: target.start, end: target.start, text: prefix },
      { start: target.end, end: target.end, text: suffix },
    );
  }
  return insertions;
};

const aliasEdits = (
  source: string,
  edits: readonly AliasEdit[],
): string => {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const [index, edit] of edits.entries()) {
    const name = `__equivalenceDomTarget${index}`;
    const target = source.slice(edit.targetStart, edit.targetEnd);
    const callPrefix = source.slice(edit.callStart, edit.targetStart);
    const callSuffix = source.slice(edit.targetEnd, edit.callEnd);
    const originalCall = `${callPrefix}${name}${callSuffix}`;
    replacements.push({
      start: edit.callStart,
      end: edit.callEnd,
      text: `(() => { const ${name} = ${target}; return ${originalCall}; })()`,
    });
  }
  return applyEdits(source, replacements);
};

const countMatches = (pattern: RegExp, source: string): number =>
  [...source.matchAll(pattern)].length;

type DomElementProducer = (typeof DOM_ELEMENT_PRODUCERS)[number];

const producerReceivers = (
  receiver: DomElementProducer["receiver"],
): readonly string[] => {
  switch (receiver) {
    case "document":
      return ["document"];
    case "element":
      return ['document.createElement("div")'];
    case "either":
      return [
        "document",
        'document.createElement("div")',
      ];
    default: {
      const exhaustive: never = receiver;
      throw new Error(`Unknown DOM producer receiver: ${exhaustive}`);
    }
  }
};

type CallableDomProducer = Extract<
  DomElementProducer,
  { kind: "method" | "collection" }
>;
const producerArguments = {
  createElement: '"div"',
  createElementNS: '"http://www.w3.org/1999/xhtml", "div"',
  getElementById: '"fixture"',
  querySelector: '"div"',
  closest: '"div"',
  elementFromPoint: "0, 0",
  getElementsByClassName: '"fixture"',
  getElementsByTagName: '"div"',
  getElementsByTagNameNS: '"http://www.w3.org/1999/xhtml", "div"',
  getElementsByName: '"fixture"',
  querySelectorAll: '"div"',
} as const satisfies Record<CallableDomProducer["name"], string>;

const producerExpressions = (entry: DomElementProducer): string[] => {
  const expressions: string[] = [];
  for (const receiver of producerReceivers(entry.receiver)) {
    switch (entry.kind) {
      case "property":
        expressions.push(`${receiver}.${entry.name}`);
        break;
      case "method":
        expressions.push(`${receiver}.${entry.name}(${producerArguments[entry.name]})`);
        break;
      case "collection": {
        const collection = `${receiver}.${entry.name}(${producerArguments[entry.name]})`;
        expressions.push(`${collection}[0]`, `${collection}.item(0)`);
        break;
      }
      case "collection-property": {
        const collection = `${receiver}.${entry.name}`;
        expressions.push(`${collection}[0]`, `${collection}.item(0)`);
        break;
      }
      default: {
        const exhaustive: never = entry;
        throw new Error(`Unknown DOM producer kind: ${exhaustive}`);
      }
    }
  }
  return expressions;
};

const producerCorpus = (): {
  source: string;
  invalidCount: number;
  producerIds: string[];
} => {
  const lines = [
    'declare const payload: object;',
    'declare const rawHtml: string;',
    'declare const config: Record<string, unknown>;',
    "",
  ];
  let invalidCount = 0;
  const producerIds: string[] = [];
  for (const entry of DOM_ELEMENT_PRODUCERS) {
    const producerId = `${entry.receiver}:${entry.kind}:${entry.name}`;
    producerIds.push(producerId);
    const expressions = producerExpressions(entry);
    expect(expressions.length).toBeGreaterThan(0);
    for (const [index, target] of expressions.entries()) {
      lines.push(
        `// DOM producer case ${entry.receiver}.${entry.name} (${entry.kind}) #${index + 1}`,
        `// oxlint-disable-next-line ${ruleId} -- recognized DOM target with opaque HTML source`,
        `Object.assign(${target}, payload);`,
      );
      invalidCount += 1;
    }
    if (entry.kind === "collection" || entry.kind === "collection-property") {
      for (const receiver of producerReceivers(entry.receiver)) {
        const collection =
          entry.kind === "collection"
            ? `${receiver}.${entry.name}(${producerArguments[entry.name]})`
            : `${receiver}.${entry.name}`;
        for (const access of ["elements[0]", "elements.item(0)"]) {
          lines.push(
            "{",
            `const elements = ${collection};`,
            `// oxlint-disable-next-line ${ruleId} -- stable collection binding retains indexed element provenance`,
            `Object.assign(${access}, payload);`,
            "}",
          );
          invalidCount += 1;
        }
      }
    }
  }
  const cleanTargets = [
    "config.body",
    'config.querySelector("div")',
    'config.getElementsByTagName("div")[0]',
    'config.getElementsByTagName("div").item(0)',
  ];
  for (const target of cleanTargets) {
    lines.push(
      `// expect-clean: ${ruleId} -- non-DOM receiver remains outside producer table`,
      `Object.assign(${target}, payload);`,
    );
  }
  lines.push(
    "// safe-html: fixture waiver is consumed by the first, statically safe write",
    'document.write(""); document.write(rawHtml); // oxlint-disable-line ' +
      `${ruleId} -- second same-line document.write sink is intentionally opaque`,
  );
  invalidCount += 1;
  return {
    source: `${lines.join("\n")}\n`,
    invalidCount,
    producerIds,
  };
};

const generatedHtmlSinkCorpus = (): {
  source: string;
  invalidCount: number;
  reactPropIds: string[];
  attributeSinkIds: string[];
  documentMethodIds: string[];
} => {
  const lines = [
    'declare const rawHtml: string;',
    'declare const config: { write(...values: string[]): void; writeln(...values: string[]): void };',
    'declare function createElement(type: string, props: object): unknown;',
    'declare function jsx(type: string, props: object): unknown;',
    'declare function jsxs(type: string, props: object): unknown;',
    'declare function jsxDEV(type: string, props: object): unknown;',
    'declare const React: { createElement: typeof createElement };',
    '',
  ];
  let invalidCount = 0;
  const reactPropIds: string[] = [];
  const attributeSinkIds: string[] = [];
  const documentMethodIds: string[] = [];
  type HtmlSinkCase =
    | { kind: "invalid"; label: string; code: string }
    | { kind: "clean"; label: string; code: string };
  const addCase = ({ kind, label, code }: HtmlSinkCase): void => {
    if (kind === "invalid") {
      lines.push(
        `// ${label}`,
        `// oxlint-disable-next-line ${ruleId} -- generated unsafe HTML sink case`,
        code,
      );
      invalidCount += 1;
      return;
    }
    lines.push(`// expect-clean: ${ruleId} -- ${label}`, code);
  };

  const factories = ["JSX", ...REACT_ELEMENT_FACTORIES];
  const propsFor = (
    prop: (typeof REACT_HTML_PROPS)[number],
    html: string,
  ): string => {
    const value =
      prop.kind === "payload"
        ? `{ ...{ ${prop.htmlKey}: ${html} } }`
        : html;
    return `{ ...{ ...{ ${prop.name}: ${value} } } }`;
  };
  type RenderOptions = { factory: string; props: string };
  const render = ({ factory, props }: RenderOptions): string =>
    factory === "JSX"
      ? `<iframe {...${props}} />;`
      : `${factory}("iframe", ${props});`;
  for (const prop of REACT_HTML_PROPS) {
    for (const factory of factories) {
      const id = `${factory}:${prop.name}`;
      reactPropIds.push(id);
      addCase({
        kind: "invalid",
        label: `React HTML prop ${id} has a nested dynamic spread`,
        code: render({ factory, props: propsFor(prop, "rawHtml") }),
      });
      addCase({
        kind: "clean",
        label: `React HTML prop ${id} allows nested literal static content`,
        code: render({ factory, props: propsFor(prop, '"<p>static</p>"') }),
      });
    }
  }

  for (const method of DOCUMENT_WRITE_METHODS) {
    documentMethodIds.push(method);
    addCase({
      kind: "invalid",
      label: `${method} resolves a const document alias`,
      code: `{ const doc = document; doc.${method}(rawHtml); }`,
    });
    addCase({
      kind: "invalid",
      label: `${method} resolves a const alias chain`,
      code: `{ const root = document; const doc = root; doc.${method}(rawHtml); }`,
    });
    addCase({
      kind: "invalid",
      label: `${method} resolves a never-reassigned let document alias`,
      code: `{ let doc = document; doc.${method}(rawHtml); }`,
    });
    addCase({
      kind: "clean",
      label: `${method} allows static content through a document alias`,
      code: `{ const doc = document; doc.${method}("<p>static</p>"); }`,
    });
    addCase({
      kind: "clean",
      label: `${method} leaves a cyclic alias unresolved`,
      code: `{ const first = second; const second = first; first.${method}(rawHtml); }`,
    });
    addCase({
      kind: "clean",
      label: `${method} leaves a reassigned document alias unresolved`,
      code: `{ let doc = document; doc = config; doc.${method}(rawHtml); }`,
    });
    addCase({
      kind: "clean",
      label: `${method} ignores a non-document receiver`,
      code: `config.${method}(rawHtml);`,
    });
  }

  for (const sink of HTML_ATTRIBUTE_SINKS) {
    attributeSinkIds.push(sink.name);
    type AttributeArguments = { name: string; value: string };
    const argsFor = ({ name, value }: AttributeArguments): string[] => {
      const args = Array.from(
        { length: Math.max(sink.nameIndex, sink.valueIndex) + 1 },
        () => '"unused"',
      );
      args[sink.nameIndex] = JSON.stringify(name);
      args[sink.valueIndex] = value;
      return args;
    };
    for (const name of ["srcdoc", "sRcDoC"]) {
      addCase({
        kind: "invalid",
        label: `${sink.name} recognizes ${name}`,
        code: `document.createElement("div").${sink.name}(${argsFor({ name, value: "rawHtml" }).join(", ")});`,
      });
      addCase({
        kind: "clean",
        label: `${sink.name} allows a static ${name}`,
        code: `document.createElement("div").${sink.name}(${argsFor({ name, value: '"<p>static</p>"' }).join(", ")});`,
      });
    }
    addCase({
      kind: "clean",
      label: `${sink.name} ignores unrelated attributes`,
      code: `document.createElement("div").${sink.name}(${argsFor({ name: "title", value: "rawHtml" }).join(", ")});`,
    });
  }

  return {
    source: `${lines.join("\n")}\n`,
    invalidCount,
    reactPropIds,
    attributeSinkIds,
    documentMethodIds,
  };
};

test(
  "HTML sink fixtures keep their invalid and clean outcomes across equivalent syntax",
  async () => {
    const {
      source: producerSource,
      invalidCount: producerInvalidCount,
      producerIds,
    } = producerCorpus();
    const {
      source: htmlSinkSource,
      invalidCount: htmlSinkInvalidCount,
      reactPropIds,
      attributeSinkIds,
      documentMethodIds,
    } = generatedHtmlSinkCorpus();
    const htmlSinkFactories = ["JSX", ...REACT_ELEMENT_FACTORIES];
    const expectedReactPropIds = REACT_HTML_PROPS.flatMap((prop) =>
      htmlSinkFactories.map((factory) => `${factory}:${prop.name}`),
    );
    const expectedHtmlSinkInvalidCount =
      REACT_HTML_PROPS.length * htmlSinkFactories.length +
      DOCUMENT_WRITE_METHODS.size * 3 +
      HTML_ATTRIBUTE_SINKS.length * 2;
    expect(htmlSinkInvalidCount).toBe(expectedHtmlSinkInvalidCount);
    expect([...new Set(reactPropIds)].sort()).toEqual(
      [...new Set(expectedReactPropIds)].sort(),
    );
    expect(reactPropIds).toHaveLength(expectedReactPropIds.length);
    expect(attributeSinkIds).toHaveLength(HTML_ATTRIBUTE_SINKS.length);
    expect([...new Set(attributeSinkIds)].sort()).toEqual(
      HTML_ATTRIBUTE_SINKS.map(({ name }) => name).sort(),
    );
    expect(documentMethodIds).toHaveLength(DOCUMENT_WRITE_METHODS.size);
    expect([...new Set(documentMethodIds)].sort()).toEqual(
      [...DOCUMENT_WRITE_METHODS].sort(),
    );
    const expectedProducerIds = DOM_ELEMENT_PRODUCERS.map(
      ({ receiver, kind, name }) => `${receiver}:${kind}:${name}`,
    );
    expect([...new Set(producerIds)].sort()).toEqual(
      [...new Set(expectedProducerIds)].sort(),
    );
    expect(producerIds).toHaveLength(expectedProducerIds.length);
    expect(new Set(producerIds).size).toBe(DOM_ELEMENT_PRODUCERS.length);
    const tempDirectory = await mkdtemp(join(fixtureRoot, "html-equivalence-"));
    const collectorPath = join(tempDirectory, "collector.mjs");
    const configPrefix = `.html-equivalence-${basename(tempDirectory)}`;
    const collectorConfigPath = join(repositoryRoot, `${configPrefix}-collector.json`);
    const targetCollectorConfigPath = join(repositoryRoot, `${configPrefix}-targets.json`);
    const ruleConfigPath = join(repositoryRoot, `${configPrefix}-rule.json`);
    const producerCorpusPath = join(tempDirectory, "dom-producer-corpus.fixture.tsx");
    const htmlSinkCorpusPath = join(tempDirectory, "html-sink-corpus.fixture.tsx");
    const targetCollectorPath = join(tempDirectory, "target-collector.mjs");

    try {
      await writeFile(producerCorpusPath, producerSource);
      await writeFile(htmlSinkCorpusPath, htmlSinkSource);
      const originalPaths = (await readdir(fixtureRoot))
        .filter(
          (name) =>
            name.startsWith("no-unsafe-inner-html") &&
            name.endsWith(".fixture.tsx"),
        )
        .sort()
        .map((name) => join(fixtureRoot, name));
      expect(originalPaths.length).toBeGreaterThan(0);
      originalPaths.push(producerCorpusPath, htmlSinkCorpusPath);
      const originals = await Promise.all(
        originalPaths.map(async (path) => ({ path, source: await readFile(path, "utf8") })),
      );
      const expectedInvalidCount = originals.reduce(
        (count, { source }) => count + countMatches(invalidDirective, source),
        0,
      );
      const expectedCleanCount = originals.reduce(
        (count, { source }) => count + countMatches(cleanMarker, source),
        0,
      );
      expect(expectedInvalidCount).toBeGreaterThan(0);
      expect(expectedCleanCount).toBeGreaterThan(0);
      expect(
        countMatches(invalidDirective, producerSource),
      ).toBe(producerInvalidCount);
      expect(countMatches(invalidDirective, htmlSinkSource)).toBe(
        htmlSinkInvalidCount,
      );

      await writeFile(collectorPath, collectorPlugin);
      const collectorConfig = {
        categories: { correctness: "off" },
        jsPlugins: [
          { name: "equivalence-collector", specifier: collectorPath },
        ],
        rules: { "equivalence-collector/edits": "error" },
      };
      const targetCollectorConfig = {
        categories: { correctness: "off" },
        jsPlugins: [
          { name: "dom-target-collector", specifier: targetCollectorPath },
        ],
        rules: { "dom-target-collector/targets": "error" },
      };
      const ruleConfig = {
        categories: { correctness: "off" },
        jsPlugins: [
          { name: "no-unsafe-inner-html", specifier: rulePath },
        ],
        rules: { [ruleId]: "error" },
        overrides: [
          {
            files: [
              ...originalPaths
                .filter((path) => basename(path).includes("provenance"))
                .map((path) => relative(repositoryRoot, path)),
              `${relative(repositoryRoot, tempDirectory)}/**/*provenance*.tsx`,
              `${relative(repositoryRoot, tempDirectory)}/**/*provenance*.ts`,
            ],
            rules: {
              [ruleId]: ["error", { sanitizerPolicy: "provenance" }],
            },
          },
        ],
      };
      await Promise.all([
        writeFile(collectorConfigPath, JSON.stringify(collectorConfig)),
        writeFile(targetCollectorConfigPath, JSON.stringify(targetCollectorConfig)),
        writeFile(ruleConfigPath, JSON.stringify(ruleConfig)),
        writeFile(targetCollectorPath, domTargetCollectorPlugin),
      ]);

      const collected = await runOxlint({
        configPath: collectorConfigPath,
        filePaths: originalPaths,
      });
      expect(collected.exitCode).toBe(1);
      const edits = parseEdits(collected.stdout);
      expect(edits.length).toBeGreaterThan(0);
      expect(edits.every((edit) => originalPaths.includes(edit.file))).toBe(true);
      const members = edits.filter(
        (edit): edit is MemberEdit => edit.kind === "member",
      );
      const aliases = edits.filter(
        (edit): edit is AliasEdit => edit.kind === "alias",
      );
      const spreads = edits.filter(
        (edit): edit is SpreadEdit => edit.kind === "spread",
      );
      const jsxRoots = edits.filter(
        (edit): edit is JsxEdit => edit.kind === "jsx",
      );
      const jsxInventory = edits.filter(
        (edit): edit is JsxInventoryEdit => edit.kind === "jsx-inventory",
      );
      expect(members.length).toBeGreaterThan(0);
      expect(aliases.length).toBeGreaterThan(0);
      expect(spreads.length).toBeGreaterThan(0);
      expect(jsxRoots.length).toBeGreaterThan(0);
      expect(jsxInventory).toHaveLength(originalPaths.length);
      expect(
        jsxRoots.reduce((count, edit) => count + edit.elementCount, 0),
      ).toBe(
        jsxInventory.reduce((count, edit) => count + edit.elementCount, 0),
      );

      const generatedPaths: string[] = [];
      const generatedSources = new Map<string, string>();
      const jsxFreeSources = new Map<string, string>();
      for (const original of originals) {
        const fixtureBasename = basename(original.path);
        const fileMembers = members.filter((edit) => edit.file === original.path);
        const fileAliases = aliases.filter((edit) => edit.file === original.path);
        const fileSpreads = spreads.filter((edit) => edit.file === original.path);
        const fileJsxRoots = jsxRoots.filter((edit) => edit.file === original.path);
        const inventory = jsxInventory.find((edit) => edit.file === original.path);
        expect(inventory).toBeDefined();
        expect(
          fileJsxRoots.reduce((count, edit) => count + edit.elementCount, 0),
        ).toBe(inventory?.elementCount);
        const variants = [
          {
            name: "bracket",
            source: applyEdits(
              original.source,
              memberEdits(original.source, fileMembers),
            ),
          },
          {
            name: "alias",
            source: aliasEdits(original.source, fileAliases),
          },
          {
            name: "spread",
            source: applyEdits(
              original.source,
              spreadEdits(original.source, fileSpreads),
            ),
          },
          {
            name: "react-create-element",
            source: applyEdits(
              original.source,
              fileJsxRoots.map((edit) => ({
                start: edit.start,
                end: edit.end,
                text: edit.reactText,
              })),
            ),
          },
          {
            name: "jsx-call",
            source: applyEdits(
              original.source,
              fileJsxRoots.map((edit) => ({
                start: edit.start,
                end: edit.end,
                text: edit.jsxText,
              })),
            ),
          },
        ];
        const reactSource = variants.find(
          (variant) => variant.name === "react-create-element",
        )?.source;
        if (reactSource === undefined) throw new Error("Missing JSX-free source");
        const jsxFreePath = join(
          tempDirectory,
          `${fixtureBasename.replace(".fixture.tsx", "")}-react-base.ts`,
        );
        jsxFreeSources.set(jsxFreePath, reactSource);
        for (const variant of variants) {
          const generatedPath = join(
            tempDirectory,
            `${fixtureBasename.replace(".fixture.tsx", "")}-${variant.name}.fixture.tsx`,
          );
          expect(countMatches(invalidDirective, variant.source)).toBe(
            countMatches(invalidDirective, original.source),
          );
          expect(countMatches(cleanMarker, variant.source)).toBe(
            countMatches(cleanMarker, original.source),
          );
          generatedPaths.push(generatedPath);
          generatedSources.set(generatedPath, variant.source);
        }
      }
      expect(members.length).toBeGreaterThan(0);
      expect(aliases.length).toBeGreaterThan(0);
      expect(spreads.length).toBeGreaterThan(0);
      expect(jsxRoots.length).toBeGreaterThan(0);
      expect(generatedPaths).toHaveLength(originals.length * 5);
      await Promise.all(
        [...generatedSources].map(([path, source]) => writeFile(path, source)),
      );
      await Promise.all(
        [...jsxFreeSources].map(([path, source]) => writeFile(path, source)),
      );

      const targetCollection = await runOxlint({
        configPath: targetCollectorConfigPath,
        filePaths: [...jsxFreeSources.keys()],
      });
      expect(targetCollection.exitCode).toBe(1);
      const collectedTargetEdits = parseEdits(targetCollection.stdout);
      const expressionWrapperInventories = collectedTargetEdits.filter(
        (edit): edit is ExpressionWrapperInventoryEdit =>
          edit.kind === "expression-wrapper-inventory",
      );
      expect(expressionWrapperInventories).toHaveLength(jsxFreeSources.size);
      const expectedExpressionNodeTypes = [
        ...EXPRESSION_WRAPPER_TYPES,
        ...Object.keys(expressionCarrierPolicies),
      ].sort();
      const peeledExpressionNodeTypes = Object.entries(expressionWrapperPolicies)
        .filter(([, policy]) => policy.disposition === "peel")
        .map(([type]) => type)
        .sort();
      expect(peeledExpressionNodeTypes).toEqual([...EXPRESSION_WRAPPER_TYPES].sort());
      expect(
        Object.values(expressionWrapperPolicies).every(
          ({ reason }) => reason.length > 0,
        ),
      ).toBe(true);
      for (const inventory of expressionWrapperInventories) {
        expect(inventory.types).toEqual(expectedExpressionNodeTypes);
      }
      const targetEdits = collectedTargetEdits.filter(
        (edit): edit is DomTargetInventoryEdit =>
          edit.kind === "dom-target-inventory",
      );
      expect(targetEdits).toHaveLength(jsxFreeSources.size);
      const targetEditsByFile = new Map<string, DomTarget[]>();
      for (const edit of targetEdits) {
        if (targetEditsByFile.has(edit.file)) {
          throw new Error(`Duplicate target inventory for ${edit.file}`);
        }
        targetEditsByFile.set(edit.file, edit.targets);
      }
      const wrapperPaths: string[] = [];
      const wrapperSources = new Map<string, string>();
      let wrappedTargetCount = 0;
      for (const [basePath, source] of jsxFreeSources) {
        const targets = targetEditsByFile.get(resolve(basePath));
        if (!targets) throw new Error(`Missing target inventory for ${basePath}`);
        const uniqueTargets = new Set(targets.map(({ start, end }) => `${start}:${end}`));
        expect(uniqueTargets.size).toBe(targets.length);
        for (const wrapper of wrapperKinds) {
          const insertions = wrapperInsertions(source, targets, wrapper);
          expect(insertions).toHaveLength(targets.length * 2);
          const wrapped = applyEdits(source, insertions);
          expect(countMatches(invalidDirective, wrapped)).toBe(
            countMatches(invalidDirective, source),
          );
          expect(countMatches(cleanMarker, wrapped)).toBe(
            countMatches(cleanMarker, source),
          );
          const wrapperPath = join(
            tempDirectory,
            `${basename(basePath, ".ts")}-${wrapper}.fixture.ts`,
          );
          wrapperPaths.push(wrapperPath);
          wrapperSources.set(wrapperPath, wrapped);
          wrappedTargetCount += targets.length;
        }
      }
      expect(
        [...targetEditsByFile.values()].reduce(
          (total, targets) => total + targets.length,
          0,
        ),
      ).toBeGreaterThan(0);
      expect(wrappedTargetCount).toBe(
        [...targetEditsByFile.values()].reduce(
          (total, targets) => total + targets.length * wrapperKinds.length,
          0,
        ),
      );
      expect(wrapperPaths).toHaveLength(
        jsxFreeSources.size * wrapperKinds.length,
      );
      await Promise.all(
        [...wrapperSources].map(([path, source]) => writeFile(path, source)),
      );

      const verified = await runOxlint({
        configPath: ruleConfigPath,
        filePaths: [...originalPaths, ...generatedPaths, ...wrapperPaths],
        extraArgs: [
          "--report-unused-disable-directives-severity=error",
          "--deny-warnings",
        ],
      });
      expect(verified.exitCode).toBe(0);
      if (verified.stdout.trim() !== "") {
        const diagnostics: unknown = JSON.parse(verified.stdout);
        expect(hasDiagnostics(diagnostics)).toBe(false);
      }
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
      await Promise.all([
        rm(collectorConfigPath, { force: true }),
        rm(targetCollectorConfigPath, { force: true }),
        rm(ruleConfigPath, { force: true }),
      ]);
    }
  },
  30_000,
);

test("expression unwrapping follows the syntax wrapper policy exactly", () => {
  let nested: unknown = { type: "Identifier", range: [0, 1] };
  for (const type of EXPRESSION_WRAPPER_TYPES) {
    nested = { type, range: [0, 1], expression: nested };
  }
  expect(unwrapExpression(nested)?.type).toBe("Identifier");

  for (const type of Object.keys(expressionCarrierPolicies)) {
    const node = {
      type,
      range: [0, 1],
      expression: { type: "Identifier", range: [0, 1] },
    };
    expect(unwrapExpression(node)?.type).toBe(type);
  }
});
