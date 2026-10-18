import {
  createBindingResolver,
  identifierName,
  isNode,
  propertyName,
  testOnlyPlugin,
} from "./test-rule-utils";

export default testOnlyPlugin(
  "no-wall-clock-in-tests",
  "noWallClock",
  "Use the @stll/test-kit clock instead of reading the wall clock in tests.",
  (report, getScope) => {
    const resolveBinding = createBindingResolver(getScope);
    const isGlobal = (value: unknown, name: string): boolean =>
      isNode(value) &&
      resolveBinding(value).type === "global" &&
      identifierName(value) === name;
    const isClockMember = (value: unknown): boolean => {
      if (!isNode(value)) return false;
      if (value.type === "Identifier") {
        const binding = resolveBinding(value);
        return binding.type === "const" && isClockMember(binding.initializer);
      }
      return (
        value.type === "MemberExpression" &&
        propertyName(value.property) === "now" &&
        (isGlobal(value.object, "Date") ||
          isGlobal(value.object, "performance"))
      );
    };
    return {
      CallExpression(node) {
        if (
          isClockMember(node.callee) ||
          (isNode(node.callee) &&
            isGlobal(node.callee, "Date") &&
            Array.isArray(node.arguments) &&
            node.arguments.length === 0)
        )
          report(node);
      },
      NewExpression(node) {
        if (
          isNode(node.callee) &&
          isGlobal(node.callee, "Date") &&
          Array.isArray(node.arguments) &&
          node.arguments.length === 0
        )
          report(node);
      },
    };
  },
);
