import { identifierName, isNode, testOnlyPlugin } from "./test-rule-utils";

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
    const host = new URL(text).hostname;
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
export default testOnlyPlugin(
  "no-real-network-in-tests",
  "noRealNetwork",
  "Use @stll/test-kit's withFakeServer instead of real network access in tests.",
  (report) => {
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
          identifierName(node.callee) === "fetch" &&
          Array.isArray(node.arguments) &&
          external(node.arguments.at(0), constants)
        )
          report(node);
      },
      NewExpression(node) {
        const callee = identifierName(node.callee);
        if (
          (callee === "WebSocket" || callee === "EventSource") &&
          Array.isArray(node.arguments) &&
          external(node.arguments.at(0), constants)
        )
          report(node);
      },
    };
  },
);
