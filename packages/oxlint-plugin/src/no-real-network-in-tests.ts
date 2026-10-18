import { identifierName, isNode, testOnlyPlugin } from "./test-rule-utils";

const urlText = (value: unknown): string | null => {
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
  return null;
};
const external = (value: unknown): boolean => {
  const text = urlText(value);
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
  (report) => ({
    CallExpression(node) {
      if (
        identifierName(node.callee) === "fetch" &&
        Array.isArray(node.arguments) &&
        external(node.arguments.at(0))
      )
        report(node);
    },
    NewExpression(node) {
      const callee = identifierName(node.callee);
      if (
        (callee === "WebSocket" || callee === "EventSource") &&
        Array.isArray(node.arguments) &&
        external(node.arguments.at(0))
      )
        report(node);
    },
  }),
);
