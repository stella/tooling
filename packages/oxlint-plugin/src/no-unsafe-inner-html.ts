// Forbid injecting un-proven HTML into the DOM.
//
// Raw HTML may only reach the DOM from a value that is provably sanitized or
// escaped. This rule covers common DOM and JSX sinks while allowing explicit
// sanitizer calls and narrowly scoped provenance comments.
//
// Sinks, all sharing one allowlist:
//   • `__html` of a `dangerouslySetInnerHTML` object, whether the object is a
//     JSX attribute value or a property of any object literal (props passed
//     to `createElement` / `jsx()`, or spread into JSX).
//   • assignment to `innerHTML`, `outerHTML` or `srcdoc`, dot or static
//     bracket notation, and the same keys in an `Object.assign` source.
//   • the JSX `srcDoc` attribute.
//   • `insertAdjacentHTML`, `setHTMLUnsafe`, `createContextualFragment`,
//     `setAttribute("srcdoc", …)`, and `write` / `writeln` on a document.
//
// In the default `allowlist` policy, a value is allowed when it is:
//   • a static string Literal or TemplateLiteral whose interpolations are all
//     independently static, OR
//   • passed through the shared HTML sanitizer allowlist (`escapeHtml`,
//     `escapeXml`, `sanitizeHtml`, `sanitizeDom`, `DOMPurify.sanitize`, and
//     related established names), including `.value` / `.data` / `.html`
//     result accessors; OR
//   • annotated by a `// safe-html: <provenance>` comment with non-empty text
//     on the line directly above the sink. One comment covers one sink: a
//     second sink starting on the same line needs its own annotation.
// The `provenance` policy omits the sanitizer-name allowlist and requires the
// comment for dynamic sanitizer results as well.
//
// The sanitizer allowlist preserves the shared plugin contract. For dynamic
// values outside that list, function names are not proof: a local identity
// function can be named `sanitizeHtml`. Add explicit provenance at the sink
// until the codebase has a branded SafeHtml boundary.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import {
  getCalleeName,
  getPropertyName,
  invokedCallee,
  isAstNode,
  isIdentifier,
  isMemberAccess,
  isStringLiteral,
  memberPropertyName,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

// The provenance text after the marker must be non-empty.
const WAIVER_RE = /^\s*safe-html:\s*\S/u;

const DANGEROUS_PROP = "dangerouslySetInnerHTML";
const HTML_KEY = "__html";
const HTML_PROPERTIES: ReadonlySet<string> = new Set([
  "innerHTML",
  "outerHTML",
  "srcdoc",
]);
const DANGEROUS_PROP_ATTRIBUTES: ReadonlySet<string> = new Set([
  DANGEROUS_PROP,
]);
const SRCDOC_ATTRIBUTES: ReadonlySet<string> = new Set(["srcDoc", "srcdoc"]);
// Methods whose first argument is parsed as HTML.
const HTML_FIRST_ARGUMENT_METHODS: ReadonlySet<string> = new Set([
  "createContextualFragment",
  "setHTMLUnsafe",
]);
const DOCUMENT_WRITE_METHODS: ReadonlySet<string> = new Set([
  "write",
  "writeln",
]);
const DOCUMENT_MEMBERS: ReadonlySet<string> = new Set([
  "contentDocument",
  "document",
  "ownerDocument",
]);

const HTML_SANITIZER_LEAF_RE =
  /^(?:escape(?:html|xml)|sanitize(?:html|dom)|purify(?:html|dom)|dompurify)$/iu;
const SANITIZER_RESULT_MEMBERS = new Set(["value", "data", "html"]);
const SANITIZER_POLICY = {
  allowlist: "allowlist",
  provenance: "provenance",
} as const;
const SANITIZER_POLICY_VALUES = Object.values(SANITIZER_POLICY);
type SanitizerPolicy = (typeof SANITIZER_POLICY)[keyof typeof SANITIZER_POLICY];

const sanitizerPolicyFrom = (option: unknown): SanitizerPolicy => {
  if (option === undefined) {
    return SANITIZER_POLICY.allowlist;
  }
  if (typeof option !== "object" || option === null || Array.isArray(option)) {
    throw new Error("no-unsafe-inner-html options must be an object");
  }
  const policy = Reflect.get(option, "sanitizerPolicy");
  switch (policy) {
    case undefined:
    case SANITIZER_POLICY.allowlist:
      return SANITIZER_POLICY.allowlist;
    case SANITIZER_POLICY.provenance:
      return SANITIZER_POLICY.provenance;
    default:
      throw new Error(`unknown sanitizer policy: ${String(policy)}`);
  }
};

const isSanitizerCall = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const dotted = getCalleeName(node.callee);
  if (dotted === null) {
    return false;
  }
  const parts = dotted.split(".");
  const leaf = parts.at(-1);
  if (leaf === undefined) {
    return false;
  }
  if (HTML_SANITIZER_LEAF_RE.test(leaf)) {
    return true;
  }
  return leaf === "sanitize" && /^dompurify$/iu.test(parts.at(-2) ?? "");
};

const isSanitizerResult = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (
    expression?.type !== "MemberExpression" ||
    expression.computed !== false
  ) {
    return false;
  }
  const property = memberPropertyName(expression);
  return (
    property !== null &&
    SANITIZER_RESULT_MEMBERS.has(property) &&
    isSanitizerCall(expression.object)
  );
};

type Located = { loc: { start: { line: number } } };

const hasLocation = (node: unknown): node is Located =>
  typeof node === "object" &&
  node !== null &&
  "loc" in node &&
  typeof node.loc === "object" &&
  node.loc !== null &&
  "start" in node.loc &&
  typeof node.loc.start === "object" &&
  node.loc.start !== null &&
  "line" in node.loc.start &&
  typeof node.loc.start.line === "number";

// A node without location data never matches a waiver line.
const startLine = (node: unknown): number =>
  hasLocation(node) ? node.loc.start.line : Number.NaN;

type WaiverComment = {
  value: string;
  loc: { end: { line: number } };
};

const isWaiverComment = (value: unknown): value is WaiverComment =>
  typeof value === "object" &&
  value !== null &&
  "value" in value &&
  typeof value.value === "string" &&
  WAIVER_RE.test(value.value) &&
  "loc" in value &&
  typeof value.loc === "object" &&
  value.loc !== null;

const isJsxIdentifierIn = (
  node: unknown,
  names: ReadonlySet<string>,
): boolean =>
  isAstNode(node) &&
  node.type === "JSXIdentifier" &&
  typeof node.name === "string" &&
  names.has(node.name);

// A value is proven safe by its own static shape, independent of comments.
const isProvenSafeValue = (
  node: unknown,
  sanitizerPolicy: SanitizerPolicy,
): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return false;
  }
  if (isStringLiteral(expression)) {
    return true;
  }
  if (
    sanitizerPolicy === SANITIZER_POLICY.allowlist &&
    (isSanitizerCall(expression) || isSanitizerResult(expression))
  ) {
    return true;
  }
  return (
    expression.type === "TemplateLiteral" &&
    Array.isArray(expression.expressions) &&
    expression.expressions.every((entry) =>
      isProvenSafeValue(entry, sanitizerPolicy),
    )
  );
};

// The static key of an object-literal Property: `a`, `"a"`, `["a"]`.
const objectPropertyKey = (property: unknown): string | null => {
  if (!isAstNode(property)) {
    return null;
  }
  if (property.computed === true) {
    return staticStringValue(property.key);
  }
  return getPropertyName(property.key);
};

const objectProperties = (node: unknown): AstNode[] => {
  const expression = unwrapExpression(node);
  if (
    expression?.type !== "ObjectExpression" ||
    !Array.isArray(expression.properties)
  ) {
    return [];
  }
  return expression.properties.filter(isAstNode);
};

type AppliedArguments =
  | { status: "known"; args: unknown[] }
  | { status: "opaque" };

const appliedArgumentsFor = (args: unknown[]): AppliedArguments => {
  const applied = unwrapExpression(args.at(1));
  if (
    applied === null ||
    (applied.type === "Literal" && applied.value === null) ||
    isIdentifier(applied, "undefined")
  ) {
    return { status: "known", args: [] };
  }
  if (applied.type !== "ArrayExpression" || !Array.isArray(applied.elements)) {
    return { status: "opaque" };
  }
  return { status: "known", args: applied.elements };
};

// The arguments the invoked function receives: `f.call(thisArg, ...args)`
// shifts them by one; `f.apply(thisArg, [...])` forwards a literal array.
const invokedArguments = (call: unknown): unknown[] => {
  if (!isAstNode(call)) {
    return [];
  }
  const args = Array.isArray(call.arguments) ? call.arguments : [];
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression") {
    return args;
  }
  const method = memberPropertyName(callee);
  if (method === "call") {
    return args.slice(1);
  }
  if (method !== "apply") {
    return args;
  }
  const applied = appliedArgumentsFor(args);
  if (applied.status === "opaque") {
    // Preserve an opaque sentinel so known sinks fail closed.
    return [call, call];
  }
  return applied.args;
};

const resolvedForwardedArguments = (args: unknown[]): AppliedArguments => {
  const forwarded: unknown[] = [];
  const append = (argument: unknown): boolean => {
    if (!isAstNode(argument) || argument.type !== "SpreadElement") {
      forwarded.push(argument);
      return true;
    }
    const expression = unwrapExpression(argument.argument);
    if (
      expression?.type !== "ArrayExpression" ||
      !Array.isArray(expression.elements)
    )
      return false;
    for (const element of expression.elements)
      if (!append(element)) return false;
    return true;
  };
  for (const argument of args)
    if (!append(argument)) return { status: "opaque" };
  return { status: "known", args: forwarded };
};

const sinkArgumentsFor = (call: unknown): AppliedArguments => {
  if (!isAstNode(call) || call.type !== "CallExpression")
    return { status: "opaque" };
  const rawArguments = Array.isArray(call.arguments) ? call.arguments : [];
  const callArguments = resolvedForwardedArguments(rawArguments);
  if (callArguments.status === "opaque") return callArguments;
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression") return callArguments;
  const method = memberPropertyName(callee);
  if (method === "call")
    return { status: "known", args: callArguments.args.slice(1) };
  if (method !== "apply") return callArguments;
  const applied = appliedArgumentsFor(callArguments.args);
  return applied.status === "opaque"
    ? applied
    : resolvedForwardedArguments(applied.args);
};

// `document.write`, `window.document.write`, `frame.contentDocument.write`,
// `node.ownerDocument.write`.
const isDocumentReceiver = (node: unknown): boolean => {
  const receiver = unwrapExpression(node);
  if (isIdentifier(receiver, "document")) {
    return true;
  }
  if (receiver?.type !== "MemberExpression") {
    return false;
  }
  const name = memberPropertyName(receiver);
  return name !== null && DOCUMENT_MEMBERS.has(name);
};

const isKnownDomTarget = (node: unknown): boolean => {
  const target = unwrapExpression(node);
  if (target?.type === "CallExpression") {
    const callee = invokedCallee(target);
    return (
      callee?.type === "MemberExpression" &&
      isDocumentReceiver(callee.object) &&
      [
        "createElement",
        "createElementNS",
        "getElementById",
        "querySelector",
      ].includes(memberPropertyName(callee) ?? "")
    );
  }
  return isDocumentReceiver(target);
};

export default eslintCompatPlugin({
  meta: { name: "no-unsafe-inner-html" },
  rules: {
    "no-unsafe-inner-html": {
      meta: {
        type: "problem",
        schema: [
          {
            type: "object",
            properties: {
              sanitizerPolicy: {
                type: "string",
                enum: SANITIZER_POLICY_VALUES,
              },
            },
            additionalProperties: false,
          },
        ],
        messages: {
          unsafeInnerHtml:
            "Dynamic HTML injected into the DOM must be static, proven by " +
            "the configured sanitizer policy, or have an adjacent " +
            "`// safe-html: <provenance>` comment naming the trusted source. " +
            "Function names outside the allowlist are not proof because a " +
            "local identity function can shadow them.",
          unsafeInnerHtmlSpread:
            "Do not spread an object into dangerouslySetInnerHTML. Keep " +
            "`__html` inline so this rule can prove the HTML value is " +
            "sanitized or escaped.",
        },
      },
      createOnce(context) {
        let sanitizerPolicy: SanitizerPolicy = SANITIZER_POLICY.allowlist;
        // Line of each waiver comment's end; a sink starting on the next line
        // consumes it, so one comment covers exactly one sink.
        const waiverLines = new Set<number>();

        const consumeWaiver = (node: unknown): boolean => {
          const line = startLine(node) - 1;
          if (!waiverLines.has(line)) {
            return false;
          }
          waiverLines.delete(line);
          return true;
        };

        const reportIfUnsafe = (node: unknown): void => {
          if (!isAstNode(node) || isProvenSafeValue(node, sanitizerPolicy)) {
            return;
          }
          if (consumeWaiver(node)) {
            return;
          }
          context.report({ node, messageId: "unsafeInnerHtml" });
        };

        // The value of a `dangerouslySetInnerHTML` prop: an inline object has
        // its `__html` checked and its spreads rejected; anything else is a
        // hoisted payload whose HTML this rule cannot see.
        const checkDangerousPayload = (value: unknown): void => {
          const expression = unwrapExpression(value);
          if (expression?.type !== "ObjectExpression") {
            reportIfUnsafe(value);
            return;
          }
          for (const property of objectProperties(expression)) {
            if (property.type === "SpreadElement") {
              context.report({
                node: property,
                messageId: "unsafeInnerHtmlSpread",
              });
              continue;
            }
            if (
              property.type === "Property" &&
              objectPropertyKey(property) === HTML_KEY
            ) {
              reportIfUnsafe(property.value);
            }
          }
        };

        const checkHtmlPropertySources = (
          sources: unknown[],
          domTarget: boolean,
        ): void => {
          for (const source of sources) {
            const expression = unwrapExpression(source);
            if (expression?.type !== "ObjectExpression") {
              if (domTarget) {
                reportIfUnsafe(source);
              }
              continue;
            }
            for (const property of objectProperties(source)) {
              if (property.type === "SpreadElement") {
                if (domTarget) {
                  reportIfUnsafe(property);
                }
                continue;
              }
              const key =
                property.type === "Property"
                  ? objectPropertyKey(property)
                  : null;
              if (key !== null && HTML_PROPERTIES.has(key)) {
                reportIfUnsafe(property.value);
              } else if (
                domTarget &&
                key === null &&
                property.computed === true
              ) {
                reportIfUnsafe(property);
              }
            }
          }
        };

        return {
          before() {
            sanitizerPolicy = sanitizerPolicyFrom(context.options.at(0));
            waiverLines.clear();
          },
          Program(node) {
            const comments: unknown[] = Array.isArray(node.comments)
              ? node.comments
              : [];
            for (const comment of comments) {
              if (isWaiverComment(comment)) {
                waiverLines.add(comment.loc.end.line);
              }
            }
          },

          JSXAttribute(node) {
            const value = node.value;
            if (!isAstNode(value) || value.type !== "JSXExpressionContainer") {
              return;
            }
            if (isJsxIdentifierIn(node.name, DANGEROUS_PROP_ATTRIBUTES)) {
              checkDangerousPayload(value.expression);
              return;
            }
            if (isJsxIdentifierIn(node.name, SRCDOC_ATTRIBUTES)) {
              reportIfUnsafe(value.expression);
            }
          },

          // `{ dangerouslySetInnerHTML: … }` outside a JSX attribute: props
          // for `createElement` / `jsx()`, or an object spread into JSX.
          Property(node) {
            if (objectPropertyKey(node) !== DANGEROUS_PROP) {
              return;
            }
            const container = node.parent;
            if (
              !isAstNode(container) ||
              container.type !== "ObjectExpression"
            ) {
              return;
            }
            checkDangerousPayload(node.value);
          },

          AssignmentExpression(node) {
            const target = unwrapExpression(node.left);
            if (target?.type !== "MemberExpression") {
              return;
            }
            const name = memberPropertyName(target);
            if (name !== null && HTML_PROPERTIES.has(name)) {
              reportIfUnsafe(node.right);
            }
          },

          CallExpression(node) {
            const call: unknown = node;
            const callee = isAstNode(call) ? invokedCallee(call) : null;
            if (callee?.type !== "MemberExpression") {
              return;
            }
            const args = invokedArguments(node);
            const method = memberPropertyName(callee);
            if (method === null) {
              return;
            }
            const sinkArguments = sinkArgumentsFor(node);
            if (HTML_FIRST_ARGUMENT_METHODS.has(method)) {
              if (sinkArguments.status === "opaque") {
                reportIfUnsafe(node);
                return;
              }
              reportIfUnsafe(sinkArguments.args.at(0));
              return;
            }
            if (method === "insertAdjacentHTML") {
              if (sinkArguments.status === "opaque") {
                reportIfUnsafe(node);
                return;
              }
              reportIfUnsafe(sinkArguments.args.at(1));
              return;
            }
            if (method === "setAttribute") {
              if (sinkArguments.status === "opaque") {
                reportIfUnsafe(node);
                return;
              }
              const attribute = staticStringValue(
                sinkArguments.args.at(0),
              );
              if (attribute?.toLowerCase() === "srcdoc") {
                reportIfUnsafe(sinkArguments.args.at(1));
              }
              return;
            }
            if (
              DOCUMENT_WRITE_METHODS.has(method) &&
              isDocumentReceiver(callee.object)
            ) {
              if (sinkArguments.status === "opaque") {
                reportIfUnsafe(node);
                return;
              }
              if (
                !sinkArguments.args.every((argument) =>
                  isProvenSafeValue(argument, sanitizerPolicy),
                ) &&
                !consumeWaiver(node)
              ) {
                context.report({ node, messageId: "unsafeInnerHtml" });
              }
              return;
            }
            if (isMemberAccess(callee, "Object", "assign")) {
              checkHtmlPropertySources(
                args.slice(1),
                isKnownDomTarget(args.at(0)),
              );
            }
          },
        };
      },
    },
  },
});
