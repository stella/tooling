import {
  createBindingResolver,
  identifierName,
  isNode,
  propertyName,
  testOnlyPlugin,
} from "./test-rule-utils";

const writeNames = new Set([
  "appendFile",
  "appendFileSync",
  "copyFile",
  "copyFileSync",
  "createWriteStream",
  "cp",
  "cpSync",
  "mkdir",
  "mkdirSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "symlink",
  "symlinkSync",
  "unlink",
  "unlinkSync",
  "writeFile",
  "writeFileSync",
]);
const fsModules = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const pathModules = new Set(["path", "node:path"]);
const absolutePath = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u;
const destinationWriteNames = new Set([
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "rename",
  "renameSync",
  "symlink",
  "symlinkSync",
]);

export default testOnlyPlugin(
  "no-checkout-writes-in-tests",
  "noCheckoutWrite",
  "Use @stll/test-kit's withTestTmpDir instead of writing inside the checkout.",
  (report, getScope) => {
    const resolveBinding = createBindingResolver(getScope);
    const isGlobal = (value: unknown, name: string): boolean => {
      if (!isNode(value)) return false;
      const binding = resolveBinding(value);
      return binding.type === "global" && binding.name === name;
    };
    const isPathBuilder = (value: unknown): boolean => {
      if (!isNode(value)) return false;
      if (value.type === "Identifier") {
        const binding = resolveBinding(value);
        return (
          binding.type === "import" &&
          pathModules.has(binding.module) &&
          (binding.imported === "join" || binding.imported === "resolve")
        );
      }
      if (value.type !== "MemberExpression") return false;
      const object = isNode(value.object) ? resolveBinding(value.object) : null;
      return (
        (propertyName(value.property) === "join" ||
          propertyName(value.property) === "resolve") &&
        object?.type === "import" &&
        pathModules.has(object.module) &&
        (object.imported === "*" || object.imported === "default")
      );
    };
    const rootedInCheckout = (value: unknown): boolean => {
      if (!isNode(value)) return false;
      if (value.type === "Identifier") {
        if (isGlobal(value, "__dirname")) return true;
        const binding = resolveBinding(value);
        return (
          binding.type === "const" && rootedInCheckout(binding.initializer)
        );
      }
      if (value.type === "Literal" && typeof value.value === "string")
        return !absolutePath.test(value.value);
      if (
        value.type === "TemplateLiteral" &&
        Array.isArray(value.expressions) &&
        Array.isArray(value.quasis)
      ) {
        const quasi = value.quasis.at(0);
        const raw = isNode(quasi)
          ? Reflect.get(quasi.value ?? {}, "raw")
          : null;
        if (typeof raw !== "string") return false;
        if (raw.length > 0) return !absolutePath.test(raw);
        return rootedInCheckout(value.expressions.at(0));
      }
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
        value.type === "CallExpression" &&
        isNode(value.callee) &&
        isGlobal(value.callee.object, "process") &&
        propertyName(value.callee.property) === "cwd"
      )
        return true;
      if (
        value.type === "CallExpression" &&
        isPathBuilder(value.callee) &&
        Array.isArray(value.arguments)
      )
        return rootedInCheckout(value.arguments.at(0));
      if (value.type === "BinaryExpression")
        return rootedInCheckout(value.left);
      return false;
    };
    const fsWriteName = (value: unknown): string | null => {
      if (!isNode(value)) return null;
      if (value.type === "Identifier") {
        const binding = resolveBinding(value);
        if (binding.type === "const") return fsWriteName(binding.initializer);
        return binding.type === "import" &&
          fsModules.has(binding.module) &&
          writeNames.has(binding.imported)
          ? binding.imported
          : null;
      }
      if (value.type !== "MemberExpression") return null;
      const method = propertyName(value.property);
      if (method === null || !writeNames.has(method)) return null;
      if (isNode(value.object)) {
        const object = resolveBinding(value.object);
        if (
          object.type === "import" &&
          fsModules.has(object.module) &&
          (object.imported === "*" ||
            object.imported === "default" ||
            object.imported === "promises")
        )
          return method;
        if (
          value.object.type === "MemberExpression" &&
          propertyName(value.object.property) === "promises" &&
          isNode(value.object.object)
        ) {
          const namespace = resolveBinding(value.object.object);
          return namespace.type === "import" &&
            fsModules.has(namespace.module) &&
            (namespace.imported === "*" || namespace.imported === "default")
            ? method
            : null;
        }
      }
      return null;
    };
    const bunWrite = (value: unknown): boolean =>
      isNode(value) &&
      value.type === "MemberExpression" &&
      propertyName(value.property) === "write" &&
      isGlobal(value.object, "Bun");
    return {
      CallExpression(node) {
        const writeName = fsWriteName(node.callee);
        if (
          (writeName !== null || bunWrite(node.callee)) &&
          Array.isArray(node.arguments) &&
          rootedInCheckout(
            node.arguments.at(
              writeName !== null && destinationWriteNames.has(writeName)
                ? 1
                : 0,
            ),
          )
        )
          report(node);
      },
    };
  },
);
