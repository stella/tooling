import type { Plugin } from "@oxlint/plugins";

import {
  createBindingResolver,
  identifierName,
  isNode,
  propertyName,
  testOnlyPlugin,
} from "./test-rule-utils";

const ipv4Loopback = /^127(?:\.\d{1,3}){3}$/u;

const urlText = (
  value: unknown,
  resolveBinding: ReturnType<typeof createBindingResolver>,
): string | null => {
  if (!isNode(value)) return null;
  if (value.type === "Literal" && typeof value.value === "string")
    return value.value;
  if (
    value.type === "TemplateLiteral" &&
    Array.isArray(value.quasis) &&
    Array.isArray(value.expressions)
  ) {
    let text = "";
    for (const [index, part] of value.quasis.entries()) {
      const raw = isNode(part) ? Reflect.get(part.value ?? {}, "raw") : null;
      if (typeof raw !== "string") return null;
      text += raw;
      const expression = value.expressions.at(index);
      if (expression === undefined) continue;
      const resolved = urlText(expression, resolveBinding);
      if (resolved === null) return null;
      text += resolved;
    }
    return text;
  }
  if (value.type === "Identifier") {
    const binding = resolveBinding(value);
    return binding.type === "const"
      ? urlText(binding.initializer, resolveBinding)
      : null;
  }
  if (
    value.type === "NewExpression" &&
    isNode(value.callee) &&
    resolveBinding(value.callee).type === "global" &&
    identifierName(value.callee) === "URL" &&
    Array.isArray(value.arguments)
  )
    return urlText(value.arguments.at(0), resolveBinding);
  return null;
};
const external = (
  value: unknown,
  resolveBinding: ReturnType<typeof createBindingResolver>,
): boolean => {
  const text = urlText(value, resolveBinding);
  if (text === null) return false;
  try {
    const { hostname: host, protocol } = new URL(text);
    if (!["http:", "https:", "ws:", "wss:"].includes(protocol) || host === "")
      return false;
    return (
      host !== "localhost" &&
      !ipv4Loopback.test(host) &&
      host !== "::1" &&
      host !== "[::1]" &&
      !host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
};

const plugin: Plugin = testOnlyPlugin(
  "no-real-network-in-tests",
  "noRealNetwork",
  "Use @stll/test-kit's withFakeServer instead of real network access in tests.",
  (report, getScope) => {
    const resolveBinding = createBindingResolver(getScope);
    const isGlobalCallee = (value: unknown, name: string): boolean => {
      if (!isNode(value)) return false;
      if (value.type === "Identifier") {
        const binding = resolveBinding(value);
        return binding.type === "global" && binding.name === name;
      }
      if (
        value.type !== "MemberExpression" ||
        propertyName(value.property) !== name
      )
        return false;
      return (
        isNode(value.object) &&
        resolveBinding(value.object).type === "global" &&
        identifierName(value.object) === "globalThis"
      );
    };
    return {
      CallExpression(node) {
        if (
          isGlobalCallee(node.callee, "fetch") &&
          Array.isArray(node.arguments) &&
          external(node.arguments.at(0), resolveBinding)
        )
          report(node);
      },
      NewExpression(node) {
        if (
          (isGlobalCallee(node.callee, "WebSocket") ||
            isGlobalCallee(node.callee, "EventSource")) &&
          Array.isArray(node.arguments) &&
          external(node.arguments.at(0), resolveBinding)
        )
          report(node);
      },
    };
  },
);

export default plugin;
