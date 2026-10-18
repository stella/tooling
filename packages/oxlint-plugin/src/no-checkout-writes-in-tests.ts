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
const fsModules = new Set(["node:fs", "fs", "node:fs/promises", "fs/promises"]);
const absolutePath = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u;
const rootedInCheckout = (value: unknown): boolean => {
  if (!isNode(value)) return false;
  if (value.type === "Literal" && typeof value.value === "string")
    return !absolutePath.test(value.value);
  if (
    value.type === "TemplateLiteral" &&
    Array.isArray(value.expressions) &&
    value.expressions.length === 0 &&
    Array.isArray(value.quasis)
  ) {
    const quasi = value.quasis.at(0);
    const raw = isNode(quasi) ? Reflect.get(quasi.value ?? {}, "raw") : null;
    return typeof raw === "string" && !absolutePath.test(raw);
  }
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
const memberParts = (value: unknown): string[] | null => {
  if (!isNode(value)) return null;
  const identifier = identifierName(value);
  if (identifier !== null) return [identifier];
  if (value.type !== "MemberExpression") return null;
  const object = memberParts(value.object);
  const property = propertyName(value.property);
  return object === null || property === null ? null : [...object, property];
};
export default testOnlyPlugin(
  "no-checkout-writes-in-tests",
  "noCheckoutWrite",
  "Use @stll/test-kit's withTestTmpDir instead of writing inside the checkout.",
  (report) => {
    const namedWrites = new Set<string>();
    const fsNamespaces = new Set<string>();
    return {
      ImportDeclaration(node) {
        if (
          !isNode(node.source) ||
          typeof node.source.value !== "string" ||
          !fsModules.has(node.source.value) ||
          !Array.isArray(node.specifiers)
        )
          return;
        for (const specifier of node.specifiers) {
          if (!isNode(specifier)) continue;
          const local = identifierName(specifier.local);
          if (local === null) continue;
          // `import * as fs`, `import fs` and `import { promises as fsp }`
          // all bind an object whose members are the filesystem writes.
          if (
            specifier.type === "ImportNamespaceSpecifier" ||
            specifier.type === "ImportDefaultSpecifier"
          ) {
            fsNamespaces.add(local);
            continue;
          }
          const imported = propertyName(specifier.imported);
          if (imported === "promises") fsNamespaces.add(local);
          else if (imported !== null && writeNames.has(imported))
            namedWrites.add(local);
        }
      },
      CallExpression(node) {
        const callee = isNode(node.callee) ? node.callee : null;
        if (callee === null || !Array.isArray(node.arguments)) return;
        const name = identifierName(callee);
        const parts = memberParts(callee);
        const isFsMember =
          parts !== null &&
          fsNamespaces.has(parts.at(0) ?? "") &&
          writeNames.has(parts.at(-1) ?? "") &&
          (parts.length === 2 ||
            (parts.length === 3 && parts.at(1) === "promises"));
        const isBunWrite =
          parts?.length === 2 && parts.join(".") === "Bun.write";
        if (
          (name !== null && namedWrites.has(name)) ||
          isFsMember ||
          isBunWrite
        ) {
          if (rootedInCheckout(node.arguments.at(0))) report(node);
        }
      },
    };
  },
);
