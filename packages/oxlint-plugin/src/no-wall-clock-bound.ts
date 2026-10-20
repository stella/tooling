import type { Scope } from "@oxlint/plugins";

import {
  createBindingResolver,
  identifierName,
  isNode,
  propertyName,
  testOnlyPlugin,
  type Node,
} from "./test-rule-utils";

const comparisonMatcherBoundPositions: Readonly<
  Record<string, readonly number[]>
> = {
  toBeCloseTo: [0],
  toBeGreaterThan: [0],
  toBeGreaterThanOrEqual: [0],
  toBeLessThan: [0],
  toBeLessThanOrEqual: [0],
  toBeWithin: [0, 1],
};
const timerModules = new Set([
  "node:timers/promises",
  "timers/promises",
  "@stll/test-kit",
]);
const timerHelpers = new Set(["delay", "setTimeout", "sleep"]);
const testModules = new Set(["@jest/globals", "bun:test", "vitest"]);
const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const matcherModifiers = new Set(["not", "rejects", "resolves"]);

const enclosingFunction = (node: Node): Node | null => {
  let current = node.parent;
  while (isNode(current)) {
    if (functionTypes.has(current.type)) return current;
    current = current.parent;
  }
  return null;
};

export default testOnlyPlugin(
  "no-wall-clock-bound",
  "noWallClockBound",
  "A test must not assert an absolute duration or race a timer: loaded runners make these checks flaky. Assert relative growth across input sizes for performance, or use a controlled clock or deferred for ordering.",
  (report, getScope) => {
    const resolveBinding = createBindingResolver(getScope);

    const isGlobalMember = (
      node: Node,
      objectName: string,
      member: string,
    ): boolean => {
      if (node.type !== "MemberExpression") return false;
      if (propertyName(node.property) !== member || !isNode(node.object))
        return false;
      const binding = resolveBinding(node.object);
      return binding.type === "global" && binding.name === objectName;
    };

    const isClockRead = (value: unknown): boolean => {
      if (!isNode(value) || value.type !== "CallExpression") return false;
      if (!isNode(value.callee)) return false;
      if (
        isGlobalMember(value.callee, "performance", "now") ||
        isGlobalMember(value.callee, "Date", "now") ||
        isGlobalMember(value.callee, "Bun", "nanoseconds")
      )
        return true;
      const callee = value.callee;
      return (
        callee.type === "MemberExpression" &&
        propertyName(callee.property) === "bigint" &&
        isNode(callee.object) &&
        isGlobalMember(callee.object, "process", "hrtime")
      );
    };

    const constInitializerInSameFunction = (
      identifier: Node,
      use: Node,
    ): Node | null => {
      const name = identifierName(identifier);
      if (name === null) return null;
      let scope: Scope | null = getScope(identifier);
      while (scope !== null) {
        const variable = scope.set.get(name);
        if (variable === undefined) {
          scope = scope.upper;
          continue;
        }
        const definition = variable.defs.at(0);
        if (definition?.type !== "Variable") return null;
        const declarator = definition.node as unknown;
        if (
          !isNode(declarator) ||
          !isNode(declarator.parent) ||
          declarator.parent.type !== "VariableDeclaration" ||
          declarator.parent.kind !== "const" ||
          !isNode(declarator.init) ||
          enclosingFunction(declarator) !== enclosingFunction(use)
        )
          return null;
        return declarator.init;
      }
      return null;
    };

    const isClockOperand = (value: unknown, use: Node): boolean => {
      if (isClockRead(value)) return true;
      if (!isNode(value) || value.type !== "Identifier") return false;
      const initializer = constInitializerInSameFunction(value, use);
      return initializer !== null && isClockRead(initializer);
    };

    const isClockDifference = (value: unknown, use: Node): boolean =>
      isNode(value) &&
      value.type === "BinaryExpression" &&
      value.operator === "-" &&
      (isClockOperand(value.left, use) || isClockOperand(value.right, use));

    const isMeasuredDuration = (value: unknown, use: Node): boolean => {
      if (isClockDifference(value, use)) return true;
      if (!isNode(value) || value.type !== "Identifier") return false;
      const initializer = constInitializerInSameFunction(value, use);
      return initializer !== null && isClockDifference(initializer, use);
    };

    const containsMeasuredDuration = (value: unknown, use: Node): boolean => {
      if (Array.isArray(value))
        return value.some((child) => containsMeasuredDuration(child, use));
      if (!isNode(value)) return false;
      if (isMeasuredDuration(value, use)) return true;
      return Object.values(value).some(
        (child) => child !== value.parent && containsMeasuredDuration(child, use),
      );
    };

    const matcherExpectCall = (value: unknown): Node | null => {
      let current = value;
      while (
        isNode(current) &&
        current.type === "MemberExpression" &&
        matcherModifiers.has(propertyName(current.property) ?? "")
      )
        current = current.object;
      return isNode(current) && current.type === "CallExpression"
        ? current
        : null;
    };

    const containsSetTimeout = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(containsSetTimeout);
      if (!isNode(value)) return false;
      if (value.type === "CallExpression" && isNode(value.callee)) {
        const binding = resolveBinding(value.callee);
        if (binding.type === "global" && binding.name === "setTimeout")
          return true;
      }
      for (const child of Object.values(value)) {
        if (child === value.parent) continue;
        if (Array.isArray(child)) {
          if (child.some(containsSetTimeout)) return true;
        } else if (containsSetTimeout(child)) return true;
      }
      return false;
    };

    const isTimer = (value: unknown): boolean => {
      if (!isNode(value)) return false;
      if (value.type === "NewExpression") {
        if (!isNode(value.callee)) return false;
        const binding = resolveBinding(value.callee);
        return (
          binding.type === "global" &&
          binding.name === "Promise" &&
          containsSetTimeout(value.arguments)
        );
      }
      if (value.type !== "CallExpression" || !isNode(value.callee))
        return false;
      if (isGlobalMember(value.callee, "Bun", "sleep")) return true;
      const binding = resolveBinding(value.callee);
      return (
        binding.type === "import" &&
        timerModules.has(binding.module) &&
        timerHelpers.has(binding.imported)
      );
    };

    return {
      CallExpression(node) {
        if (!isNode(node.callee) || node.callee.type !== "MemberExpression")
          return;
        const member = propertyName(node.callee.property);
        if (member === "race" && isNode(node.callee.object)) {
          const binding = resolveBinding(node.callee.object);
          const firstArgument = Array.isArray(node.arguments)
            ? node.arguments.at(0)
            : null;
          if (
            binding.type === "global" &&
            binding.name === "Promise" &&
            isNode(firstArgument) &&
            firstArgument.type === "ArrayExpression" &&
            Array.isArray(firstArgument.elements) &&
            firstArgument.elements.some(isTimer)
          )
            report(node);
          return;
        }
        const expectCall = matcherExpectCall(node.callee.object);
        if (expectCall === null || !isNode(expectCall.callee)) return;
        const calleeBinding = resolveBinding(expectCall.callee);
        const isExpect =
          (calleeBinding.type === "global" &&
            calleeBinding.name === "expect") ||
          (calleeBinding.type === "import" &&
            calleeBinding.imported === "expect" &&
            testModules.has(calleeBinding.module));
        if (!isExpect) return;
        const measured = Array.isArray(expectCall.arguments)
          ? expectCall.arguments.at(0)
          : null;
        const boundPositions =
          member === null ? undefined : comparisonMatcherBoundPositions[member];
        const boundIsMeasured =
          boundPositions !== undefined &&
          Array.isArray(node.arguments) &&
          boundPositions.every((position) =>
            containsMeasuredDuration(node.arguments?.[position], node),
          );
        if (isMeasuredDuration(measured, node) && !boundIsMeasured) report(node);
      },
    };
  },
);
