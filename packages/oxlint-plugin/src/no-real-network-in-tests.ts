import type { Scope } from "@oxlint/plugins";

import {
  identifierName,
  isNode,
  memberName,
  testOnlyPlugin,
} from "./test-rule-utils";

const urlText = (
  value: unknown,
  constants: ReadonlyMap<string, unknown>,
): string | null => {
  if (!isNode(value)) return null;
  if (value.type === "Literal" && typeof value.value === "string")
    return value.value;
  if (value.type === "TemplateLiteral" && Array.isArray(value.quasis)) {
    return value.quasis
      .map((part) =>
        isNode(part) && typeof Reflect.get(part.value ?? {}, "raw") === "string"
          ? Reflect.get(part.value ?? {}, "raw")
          : "",
      )
      .join("x");
  }
  if (value.type === "Identifier" && typeof value.name === "string")
    return urlText(constants.get(value.name), constants);
  if (
    value.type === "NewExpression" &&
    identifierName(value.callee) === "URL" &&
    Array.isArray(value.arguments)
  )
    return urlText(value.arguments.at(0), constants);
  return null;
};
const external = (
  value: unknown,
  constants: ReadonlyMap<string, unknown>,
): boolean => {
  const text = urlText(value, constants);
  if (text === null) return false;
  try {
    const { hostname: host, protocol } = new URL(text);
    if (!["http:", "https:", "ws:", "wss:"].includes(protocol) || host === "")
      return false;
    return (
      host !== "localhost" &&
      host !== "127.0.0.1" &&
      host !== "::1" &&
      host !== "[::1]" &&
      !host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
};
const isGlobalIdentifier = (scope: Scope, name: string): boolean => {
  let current: Scope | null = scope;
  while (current !== null) {
    const variable = current.set.get(name);
    if (variable !== undefined) return variable.defs.length === 0;
    current = current.upper;
  }
  return true;
};
const isGlobalCallee = (value: unknown, name: string, scope: Scope): boolean =>
  (identifierName(value) === name && isGlobalIdentifier(scope, name)) ||
  memberName(value) === `globalThis.${name}`;
export default testOnlyPlugin(
  "no-real-network-in-tests",
  "noRealNetwork",
  "Use @stll/test-kit's withFakeServer instead of real network access in tests.",
  (report, getScope) => {
    const constants = new Map<string, unknown>();
    return {
      VariableDeclarator(node) {
        if (
          isNode(node.parent) &&
          node.parent.type === "VariableDeclaration" &&
          node.parent.kind === "const"
        ) {
          const name = identifierName(node.id);
          if (name !== null) constants.set(name, node.init);
        }
      },
      CallExpression(node) {
        if (
          isGlobalCallee(node.callee, "fetch", getScope(node)) &&
          Array.isArray(node.arguments) &&
          external(node.arguments.at(0), constants)
        )
          report(node);
      },
      NewExpression(node) {
        if (
          (isGlobalCallee(node.callee, "WebSocket", getScope(node)) ||
            isGlobalCallee(node.callee, "EventSource", getScope(node))) &&
          Array.isArray(node.arguments) &&
          external(node.arguments.at(0), constants)
        )
          report(node);
      },
    };
  },
);
