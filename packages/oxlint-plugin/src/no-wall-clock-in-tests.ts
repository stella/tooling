import {
  identifierName,
  isNode,
  memberName,
  testOnlyPlugin,
} from "./test-rule-utils";

const aliases = new Set<string>();

export default testOnlyPlugin(
  "no-wall-clock-in-tests",
  "noWallClock",
  "Use the @stll/test-kit clock instead of reading the wall clock in tests.",
  (report) => ({
    Program() {
      aliases.clear();
    },
    VariableDeclarator(node) {
      const name = identifierName(node.id);
      if (
        name !== null &&
        (memberName(node.init) === "Date.now" ||
          memberName(node.init) === "performance.now")
      )
        aliases.add(name);
    },
    CallExpression(node) {
      const callee = isNode(node.callee) ? node.callee : null;
      const name = callee === null ? null : identifierName(callee);
      if (
        callee !== null &&
        (memberName(callee) === "Date.now" ||
          memberName(callee) === "performance.now" ||
          (name !== null && aliases.has(name)))
      )
        report(node);
    },
    NewExpression(node) {
      if (
        identifierName(node.callee) === "Date" &&
        Array.isArray(node.arguments) &&
        node.arguments.length === 0
      )
        report(node);
    },
  }),
);
