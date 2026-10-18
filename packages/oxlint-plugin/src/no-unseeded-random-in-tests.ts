import {
  createBindingResolver,
  identifierName,
  isNode,
  propertyName,
  testOnlyPlugin,
} from "./test-rule-utils";

export default testOnlyPlugin(
  "no-unseeded-random-in-tests",
  "noUnseededRandom",
  "Use @stll/test-kit's createSeededRandom or testSeed for test input.",
  (report, getScope) => {
    const resolveBinding = createBindingResolver(getScope);
    const isGlobal = (value: unknown, name: string): boolean =>
      isNode(value) &&
      resolveBinding(value).type === "global" &&
      identifierName(value) === name;
    const isRandomMember = (value: unknown): boolean => {
      if (!isNode(value)) return false;
      if (value.type === "Identifier") {
        const binding = resolveBinding(value);
        return binding.type === "const" && isRandomMember(binding.initializer);
      }
      return (
        value.type === "MemberExpression" &&
        ((propertyName(value.property) === "random" &&
          isGlobal(value.object, "Math")) ||
          (propertyName(value.property) === "getRandomValues" &&
            isGlobal(value.object, "crypto")))
      );
    };
    return {
      CallExpression(node) {
        if (isRandomMember(node.callee)) report(node);
      },
    };
  },
);
