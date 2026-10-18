import {
  identifierName,
  isNode,
  memberName,
  propertyName,
  testOnlyPlugin,
} from "./test-rule-utils";

const writeNames = new Set([
  "writeFile",
  "writeFileSync",
  "mkdir",
  "rm",
  "appendFile",
]);
const rootedInCheckout = (value: unknown): boolean => {
  if (!isNode(value)) return false;
  if (value.type === "Literal" && typeof value.value === "string")
    return !value.value.startsWith("/");
  if (
    identifierName(value) === "__dirname" ||
    memberName(value) === "process.cwd"
  )
    return true;
  if (
    value.type === "CallExpression" &&
    memberName(value.callee) === "process.cwd"
  )
    return true;
  if (
    value.type === "MemberExpression" &&
    isNode(value.object) &&
    value.object.type === "MetaProperty" &&
    identifierName(value.object.meta) === "import" &&
    identifierName(value.object.property) === "meta"
  )
    return (
      propertyName(value.property) === "dir" ||
      propertyName(value.property) === "dirname"
    );
  if (
    (value.type === "CallExpression" ||
      value.type === "BinaryExpression" ||
      value.type === "TemplateLiteral") &&
    [
      value.callee,
      value.left,
      value.right,
      ...(Array.isArray(value.arguments) ? value.arguments : []),
      ...(Array.isArray(value.expressions) ? value.expressions : []),
    ].some(rootedInCheckout)
  )
    return true;
  return false;
};
export default testOnlyPlugin(
  "no-checkout-writes-in-tests",
  "noCheckoutWrite",
  "Use @stll/test-kit's withTestTmpDir instead of writing inside the checkout.",
  (report) => ({
    CallExpression(node) {
      const callee = isNode(node.callee) ? node.callee : null;
      if (callee === null || !Array.isArray(node.arguments)) return;
      const name = identifierName(callee);
      const member = memberName(callee);
      if (
        (name !== null && writeNames.has(name)) ||
        (member !== null &&
          (writeNames.has(member.split(".").at(-1) ?? "") ||
            member === "Bun.write"))
      ) {
        if (rootedInCheckout(node.arguments.at(0))) report(node);
      }
    },
  }),
);
