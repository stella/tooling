import {
  identifierName,
  isNode,
  memberName,
  testOnlyPlugin,
} from "./test-rule-utils";

const aliases = new Set<string>();
export default testOnlyPlugin(
  "no-unseeded-random-in-tests",
  "noUnseededRandom",
  "Use @stll/test-kit's createSeededRandom or testSeed for test input.",
  (report) => ({
    Program() {
      aliases.clear();
    },
    VariableDeclarator(node) {
      const name = identifierName(node.id);
      if (
        name !== null &&
        (memberName(node.init) === "Math.random" ||
          memberName(node.init) === "crypto.getRandomValues")
      )
        aliases.add(name);
    },
    CallExpression(node) {
      const callee = isNode(node.callee) ? node.callee : null;
      if (callee === null) return;
      const name = identifierName(callee);
      if (
        memberName(callee) === "Math.random" ||
        memberName(callee) === "crypto.getRandomValues" ||
        (name !== null && aliases.has(name))
      )
        report(node);
    },
  }),
);
