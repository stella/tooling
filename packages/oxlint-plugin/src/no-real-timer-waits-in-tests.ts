import {
  createBindingResolver,
  isNode,
  propertyName,
  testOnlyPlugin,
} from "./test-rule-utils";

const timerModules = new Set(["timers/promises", "node:timers/promises"]);

export default testOnlyPlugin(
  "no-real-timer-waits-in-tests",
  "noRealTimerWait",
  "Use @stll/test-kit's fake timers or bounded wait instead of real timer waits.",
  (report, getScope) => {
    const resolveBinding = createBindingResolver(getScope);
    const isTimer = (value: unknown): boolean => {
      if (!isNode(value)) return false;
      if (value.type === "Identifier") {
        const binding = resolveBinding(value);
        if (binding.type === "global")
          return (
            binding.name === "setTimeout" || binding.name === "setInterval"
          );
        if (binding.type === "import")
          return (
            timerModules.has(binding.module) &&
            binding.imported === "setTimeout"
          );
        return binding.type === "const" && isTimer(binding.initializer);
      }
      if (value.type !== "MemberExpression") return false;
      const object = isNode(value.object) ? resolveBinding(value.object) : null;
      const property = propertyName(value.property);
      if (
        property === "setTimeout" &&
        object?.type === "import" &&
        object.imported === "*" &&
        timerModules.has(object.module)
      )
        return true;
      if (
        (property === "setTimeout" || property === "setInterval") &&
        object?.type === "global" &&
        (object.name === "globalThis" ||
          object.name === "window" ||
          object.name === "self")
      )
        return true;
      return (
        property === "sleep" &&
        object?.type === "global" &&
        object.name === "Bun"
      );
    };
    return {
      CallExpression(node) {
        if (isTimer(node.callee)) report(node);
      },
    };
  },
);
