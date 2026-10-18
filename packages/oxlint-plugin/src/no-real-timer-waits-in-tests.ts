import {
  identifierName,
  isNode,
  memberName,
  testOnlyPlugin,
} from "./test-rule-utils";

const aliases = new Set<string>();
export default testOnlyPlugin(
  "no-real-timer-waits-in-tests",
  "noRealTimerWait",
  "Use @stll/test-kit's fake timers or bounded wait instead of real timer waits.",
  (report) => ({
    Program() {
      aliases.clear();
    },
    ImportSpecifier(node) {
      const parent = isNode(node.parent) ? node.parent : null;
      if (
        parent?.type === "ImportDeclaration" &&
        isNode(parent.source) &&
        parent.source.value === "node:timers/promises" &&
        identifierName(node.imported) === "setTimeout"
      ) {
        const local = identifierName(node.local);
        if (local !== null) aliases.add(local);
      }
    },
    VariableDeclarator(node) {
      const name = identifierName(node.id);
      const init = identifierName(node.init);
      if (
        name !== null &&
        (init === "setTimeout" ||
          init === "setInterval" ||
          memberName(node.init) === "Bun.sleep")
      )
        aliases.add(name);
    },
    CallExpression(node) {
      const callee = isNode(node.callee) ? node.callee : null;
      if (callee === null) return;
      const name = identifierName(callee);
      if (
        name === "setTimeout" ||
        name === "setInterval" ||
        memberName(callee) === "Bun.sleep" ||
        (name !== null && aliases.has(name))
      )
        report(node);
    },
  }),
);
