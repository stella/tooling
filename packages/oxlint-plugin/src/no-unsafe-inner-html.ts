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

import type { Scope, Variable } from "@oxlint/plugins";
import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode, LiteralArgumentResolution } from "./utils.ts";
import {
  getPropertyName,
  invokedCallee,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  memberPropertyName,
  resolveLiteralArraySpreads,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

type DomElementProducer = {
  name: string;
  kind: "property" | "method" | "collection";
  receiver: "document" | "element" | "either";
};

// DOM element provenance and the generated equivalence corpus share this table.
export const DOM_ELEMENT_PRODUCERS = [
  { name: "body", kind: "property", receiver: "document" },
  { name: "head", kind: "property", receiver: "document" },
  { name: "documentElement", kind: "property", receiver: "document" },
  { name: "activeElement", kind: "property", receiver: "document" },
  { name: "scrollingElement", kind: "property", receiver: "document" },
  { name: "fullscreenElement", kind: "property", receiver: "document" },
  { name: "createElement", kind: "method", receiver: "document" },
  { name: "createElementNS", kind: "method", receiver: "document" },
  { name: "getElementById", kind: "method", receiver: "document" },
  { name: "querySelector", kind: "method", receiver: "either" },
  { name: "closest", kind: "method", receiver: "element" },
  { name: "elementFromPoint", kind: "method", receiver: "document" },
  { name: "getElementsByClassName", kind: "collection", receiver: "either" },
  { name: "getElementsByTagName", kind: "collection", receiver: "either" },
  { name: "getElementsByTagNameNS", kind: "collection", receiver: "either" },
  { name: "getElementsByName", kind: "collection", receiver: "document" },
  { name: "querySelectorAll", kind: "collection", receiver: "either" },
  { name: "parentElement", kind: "property", receiver: "element" },
  { name: "firstElementChild", kind: "property", receiver: "element" },
  { name: "lastElementChild", kind: "property", receiver: "element" },
  { name: "nextElementSibling", kind: "property", receiver: "element" },
  { name: "previousElementSibling", kind: "property", receiver: "element" },
  { name: "offsetParent", kind: "property", receiver: "element" },
] as const satisfies readonly DomElementProducer[];

// The provenance text after the marker must be non-empty.
const WAIVER_RE = /^\s*safe-html:\s*\S/u;

export const REACT_HTML_PROPS = [
  { name: "dangerouslySetInnerHTML", kind: "payload", htmlKey: "__html" },
  { name: "srcDoc", kind: "value" },
  { name: "srcdoc", kind: "value" },
] as const;
type ReactHtmlProp = (typeof REACT_HTML_PROPS)[number];
const REACT_ELEMENT_FACTORIES: ReadonlySet<string> = new Set([
  "createElement",
  "React.createElement",
  "jsx",
  "jsxs",
  "jsxDEV",
]);
const HTML_PROPERTIES: ReadonlySet<string> = new Set([
  "innerHTML",
  "outerHTML",
  "srcdoc",
]);
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

// Use the same static member-name resolution for sinks and safe-value proofs.
const staticCalleeName = (node: unknown): string | null => {
  const expression = unwrapExpression(node);
  if (isIdentifier(expression)) return expression.name;
  if (expression?.type !== "MemberExpression") return null;
  const receiver = staticCalleeName(expression.object);
  const property = memberPropertyName(expression);
  return receiver === null || property === null
    ? null
    : `${receiver}.${property}`;
};

const isSanitizerCall = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const dotted = staticCalleeName(node.callee);
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
  if (expression?.type !== "MemberExpression") {
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

const jsxAttributeName = (node: unknown): string | null =>
  isAstNode(node) && node.type === "JSXIdentifier" && typeof node.name === "string"
    ? node.name
    : null;

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

const isOpaqueProperty = (property: AstNode): boolean =>
  property.type === "SpreadElement" ||
  (property.type === "Property" &&
    property.computed === true &&
    objectPropertyKey(property) === null);

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

type AppliedArguments = LiteralArgumentResolution;

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
    return { status: "opaque", args: [], spread: args.at(1), tail: [] };
  }
  return resolveLiteralArraySpreads(applied.elements);
};

// The arguments the invoked function receives: `f.call(thisArg, ...args)`
// shifts them by one; `f.apply(thisArg, [...])` forwards a literal array.
const invokedArguments = (call: unknown): AppliedArguments => {
  if (!isAstNode(call)) {
    return { status: "known", args: [] };
  }
  const rawArguments = Array.isArray(call.arguments) ? call.arguments : [];
  const resolved = resolveLiteralArraySpreads(rawArguments);
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression") return resolved;
  const method = memberPropertyName(callee);
  if (method === "call") {
    return { ...resolved, args: resolved.args.slice(1) };
  }
  if (method !== "apply") return resolved;
  if (resolved.status === "opaque") {
    if (resolved.args.length >= 2) return appliedArgumentsFor(resolved.args);
    return { ...resolved, args: [], tail: [] };
  }
  return appliedArgumentsFor(resolved.args);
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
        type DomTargetOptions = {
          node: unknown;
          scope: Scope;
          seen?: Set<Variable>;
          kind?: "element" | "collection";
        };
        const isKnownDomTarget = ({
          node,
          scope,
          seen = new Set<Variable>(),
          kind = "element",
        }: DomTargetOptions): boolean => {
          const target = unwrapExpression(node);
          if (isIdentifier(target)) {
            let current: Scope | null = scope;
            while (current !== null) {
              const variable = current.set.get(target.name);
              if (variable === undefined) {
                current = current.upper;
                continue;
              }
              if (variable.defs.length === 0) {
                return kind === "element" && isDocumentReceiver(target);
              }
              if (seen.has(variable)) return false;
              seen.add(variable);
              const definition = variable.defs.at(0);
              if (
                variable.defs.length !== 1 ||
                definition?.type !== "Variable" ||
                definition.node.type !== "VariableDeclarator" ||
                definition.node.id.type !== "Identifier" ||
                definition.node.init === null ||
                variable.references.some(
                  (reference) => reference.isWrite() && !reference.init,
                )
              ) {
                return false;
              }
              return isKnownDomTarget({
                node: definition.node.init,
                scope: context.sourceCode.getScope(definition.node),
                seen,
                kind,
              });
            }
          }
          const hasProducerReceiver = (
            receiver: unknown,
            producer: DomElementProducer,
          ): boolean => {
            if (
              producer.receiver !== "element" &&
              isDocumentReceiver(receiver)
            ) {
              return true;
            }
            return (
              producer.receiver !== "document" &&
              isKnownDomTarget({ node: receiver, scope, seen })
            );
          };
          const isElementCollection = (node: unknown): boolean =>
            isKnownDomTarget({ node, scope, seen, kind: "collection" });
          if (kind === "element" && target?.type === "MemberExpression") {
            const property = memberPropertyName(target);
            const producer = DOM_ELEMENT_PRODUCERS.find(
              (entry) => entry.kind === "property" && entry.name === property,
            );
            if (producer !== undefined) {
              return hasProducerReceiver(target.object, producer);
            }
            const index = unwrapExpression(target.property);
            if (
              target.computed === true &&
              index?.type === "Literal" &&
              typeof index.value === "number" &&
              Number.isInteger(index.value) &&
              index.value >= 0
            ) {
              return isElementCollection(target.object);
            }
          }
          if (target?.type === "CallExpression") {
            const callee = invokedCallee(target);
            if (callee?.type !== "MemberExpression") return false;
            const method = memberPropertyName(callee);
            if (
              kind === "element" &&
              method === "item" &&
              isElementCollection(callee.object)
            ) {
              return true;
            }
            const producer = DOM_ELEMENT_PRODUCERS.find(
              (entry) =>
                entry.kind === (kind === "collection" ? "collection" : "method") &&
                entry.name === method,
            );
            return (
              producer !== undefined &&
              hasProducerReceiver(callee.object, producer)
            );
          }
          return kind === "element" && isDocumentReceiver(target);
        };

        let sanitizerPolicy: SanitizerPolicy = SANITIZER_POLICY.allowlist;
        // Associate waivers after visiting the file, so source position decides
        // the first covered sink even when AST visitors inspect values out of order.
        const waiverLines = new Set<number>();
        type SinkObservation = {
          node: AstNode;
          kind: "safe" | "unsafe" | "opaque-payload";
        };
        const sinks: SinkObservation[] = [];
        const observeSink = (
          node: unknown,
          kind: SinkObservation["kind"],
        ): void => {
          if (isAstNode(node)) sinks.push({ node, kind });
        };

        const consumeWaiver = (node: unknown): boolean => {
          const line = startLine(node) - 1;
          if (!waiverLines.has(line)) {
            return false;
          }
          waiverLines.delete(line);
          return true;
        };

        const reportIfUnsafe = (node: unknown): void => {
          observeSink(
            node,
            isProvenSafeValue(node, sanitizerPolicy) ? "safe" : "unsafe",
          );
        };

        // The value of a `dangerouslySetInnerHTML` prop: an inline object has
        // its `__html` checked and its spreads rejected; anything else is a
        // hoisted payload whose HTML this rule cannot see.
        const checkDangerousPayload = (value: unknown, htmlKey: string): void => {
          const expression = unwrapExpression(value);
          if (expression?.type !== "ObjectExpression") {
            reportIfUnsafe(value);
            return;
          }
          for (const property of objectProperties(expression)) {
            if (isOpaqueProperty(property)) {
              observeSink(property, "opaque-payload");
              continue;
            }
            if (
              property.type === "Property" &&
              objectPropertyKey(property) === htmlKey
            ) {
              reportIfUnsafe(property.value);
            }
          }
        };

        const checkReactHtmlProp = (prop: ReactHtmlProp, value: unknown): void => {
          switch (prop.kind) {
            case "payload":
              checkDangerousPayload(value, prop.htmlKey);
              return;
            case "value":
              reportIfUnsafe(value);
              return;
            default: {
              const exhaustive: never = prop;
              throw new Error(`Unknown React HTML prop: ${exhaustive}`);
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
              if (isOpaqueProperty(property)) {
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
              }
            }
          }
        };

        return {
          before() {
            sanitizerPolicy = sanitizerPolicyFrom(context.options.at(0));
            waiverLines.clear();
            sinks.length = 0;
          },
          "Program:exit"() {
            sinks.sort((left, right) => left.node.range[0] - right.node.range[0]);
            for (const { node, kind } of sinks) {
              const waived = consumeWaiver(node);
              if (kind === "safe" || (kind === "unsafe" && waived)) continue;
              context.report({
                node,
                messageId:
                  kind === "opaque-payload"
                    ? "unsafeInnerHtmlSpread"
                    : "unsafeInnerHtml",
              });
            }
            sinks.length = 0;
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
            const name = jsxAttributeName(node.name);
            const prop = REACT_HTML_PROPS.find((entry) => entry.name === name);
            if (prop === undefined) return;
            const value = unwrapExpression(node.value);
            checkReactHtmlProp(
              prop,
              value?.type === "JSXExpressionContainer" ? value.expression : value,
            );
          },

          // Payload objects remain checked when hoisted or spread into JSX.
          // Direct value props require a recognized factory-call context below.
          Property(node) {
            const key = objectPropertyKey(node);
            const prop = REACT_HTML_PROPS.find((entry) => entry.name === key);
            if (prop?.kind !== "payload") return;
            const container = node.parent;
            if (isAstNode(container) && container.type === "ObjectExpression") {
              checkReactHtmlProp(prop, node.value);
            }
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
            const invoked = invokedArguments(node);
            const factory = staticCalleeName(callee);
            if (factory !== null && REACT_ELEMENT_FACTORIES.has(factory)) {
              for (const property of objectProperties(invoked.args.at(1))) {
                if (property.type !== "Property") continue;
                const key = objectPropertyKey(property);
                const prop = REACT_HTML_PROPS.find((entry) => entry.name === key);
                // Payload props are already checked by the Property visitor.
                if (prop?.kind === "value") {
                  checkReactHtmlProp(prop, property.value);
                }
              }
              return;
            }
            if (callee?.type !== "MemberExpression") {
              return;
            }
            const method = memberPropertyName(callee);
            if (method === null) {
              return;
            }
            if (HTML_FIRST_ARGUMENT_METHODS.has(method)) {
              if (invoked.status === "opaque") {
                reportIfUnsafe(node);
                return;
              }
              reportIfUnsafe(invoked.args.at(0));
              return;
            }
            if (method === "insertAdjacentHTML") {
              if (invoked.status === "opaque") {
                reportIfUnsafe(node);
                return;
              }
              reportIfUnsafe(invoked.args.at(1));
              return;
            }
            if (method === "setAttribute") {
              if (invoked.status === "opaque") {
                reportIfUnsafe(node);
                return;
              }
              const attribute = staticStringValue(invoked.args.at(0));
              if (attribute?.toLowerCase() === "srcdoc") {
                reportIfUnsafe(invoked.args.at(1));
              }
              return;
            }
            if (
              DOCUMENT_WRITE_METHODS.has(method) &&
              isDocumentReceiver(callee.object)
            ) {
              if (invoked.status === "opaque") {
                reportIfUnsafe(node);
                return;
              }
              observeSink(
                node,
                invoked.args.every((argument) =>
                  isProvenSafeValue(argument, sanitizerPolicy),
                )
                  ? "safe"
                  : "unsafe",
              );
              return;
            }
            if (isIdentifier(callee.object, "Object") && method === "assign") {
              const domTarget = isKnownDomTarget({
                node: invoked.args.at(0),
                scope: context.sourceCode.getScope(node),
              });
              checkHtmlPropertySources(
                [
                  ...invoked.args.slice(1),
                  ...(invoked.status === "opaque" ? invoked.tail : []),
                ],
                domTarget,
              );
              if (invoked.status === "opaque" && domTarget) {
                reportIfUnsafe(invoked.spread);
              }
            }
          },
        };
      },
    },
  },
});
