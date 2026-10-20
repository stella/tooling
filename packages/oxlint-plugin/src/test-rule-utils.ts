import type { ESTree, Scope } from "@oxlint/plugins";
import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext } from "./utils";

export type Node = {
  type: string;
  range: [number, number];
  arguments?: unknown;
  callee?: unknown;
  computed?: unknown;
  expressions?: unknown;
  id?: unknown;
  imported?: unknown;
  init?: unknown;
  elements?: unknown;
  operator?: unknown;
  key?: unknown;
  label?: unknown;
  kind?: unknown;
  left?: unknown;
  local?: unknown;
  meta?: unknown;
  name?: unknown;
  object?: unknown;
  parent?: unknown;
  property?: unknown;
  quasis?: unknown;
  right?: unknown;
  body?: unknown;
  source?: unknown;
  specifiers?: unknown;
  value?: unknown;
};

export const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "type") === "string";

/** `Node` is a loose view of oxlint's AST objects; every one of them carries its source span. */
const isScopeNode = (value: Node): value is Node & ESTree.Node =>
  typeof Reflect.get(value, "start") === "number" &&
  typeof Reflect.get(value, "end") === "number";

export const identifierName = (value: unknown): string | null =>
  isNode(value) && value.type === "Identifier" && typeof value.name === "string"
    ? value.name
    : null;

export const propertyName = (value: unknown): string | null => {
  if (!isNode(value)) return null;
  if (value.type === "Identifier" && typeof value.name === "string")
    return value.name;
  if (value.type === "Literal" && typeof value.value === "string")
    return value.value;
  return null;
};

export const memberName = (value: unknown): string | null => {
  if (!isNode(value) || value.type !== "MemberExpression") return null;
  const object = identifierName(value.object);
  const property = propertyName(value.property);
  return object !== null && property !== null ? `${object}.${property}` : null;
};

export type Binding =
  | { type: "global"; name: string }
  | { type: "import"; module: string; imported: string }
  | { type: "const"; initializer: Node }
  | { type: "unknown" };

const unknownBinding = { type: "unknown" } as const;
const maximumBindingDepth = 32;

export const createBindingResolver = (getScope: (node: Node) => Scope) => {
  const resolve = (
    node: Node,
    visited: ReadonlySet<object>,
    depth: number,
  ): Binding => {
    const name = identifierName(node);
    if (name === null || depth >= maximumBindingDepth || visited.has(node))
      return unknownBinding;

    const nextVisited = new Set(visited);
    nextVisited.add(node);
    let scope: Scope | null = getScope(node);
    while (scope !== null) {
      const variable = scope.set.get(name);
      if (variable === undefined) {
        scope = scope.upper;
        continue;
      }
      const definition = variable.defs.at(0);
      if (definition === undefined) return { type: "global", name };
      if (definition.type === "ImportBinding") {
        const specifier = definition.node as unknown;
        if (!isNode(specifier) || !isNode(specifier.parent))
          return unknownBinding;
        const declaration = specifier.parent;
        if (
          declaration.type !== "ImportDeclaration" ||
          !isNode(declaration.source) ||
          typeof declaration.source.value !== "string"
        )
          return unknownBinding;
        let imported = propertyName(specifier.imported);
        if (specifier.type === "ImportDefaultSpecifier") imported = "default";
        if (specifier.type === "ImportNamespaceSpecifier") imported = "*";
        return imported === null
          ? unknownBinding
          : { type: "import", module: declaration.source.value, imported };
      }
      if (definition.type !== "Variable") return unknownBinding;
      const declarator = definition.node as unknown;
      if (
        !isNode(declarator) ||
        declarator.type !== "VariableDeclarator" ||
        !isNode(declarator.parent) ||
        declarator.parent.type !== "VariableDeclaration" ||
        declarator.parent.kind !== "const" ||
        !isNode(declarator.init)
      )
        return unknownBinding;
      if (identifierName(declarator.id) !== null) {
        if (declarator.init.type !== "Identifier")
          return { type: "const", initializer: declarator.init };
        return resolve(declarator.init, nextVisited, depth + 1);
      }
      if (!isNode(declarator.id) || declarator.id.type !== "ObjectPattern")
        return unknownBinding;
      const properties = Reflect.get(declarator.id, "properties");
      if (!Array.isArray(properties)) return unknownBinding;
      const property = properties.find(
        (candidate) =>
          isNode(candidate) &&
          candidate.type === "Property" &&
          candidate.computed !== true &&
          identifierName(candidate.value) === name,
      );
      if (!isNode(property)) return unknownBinding;
      const member = propertyName(property.key);
      if (member === null || declarator.init.type !== "Identifier")
        return unknownBinding;
      const source = resolve(declarator.init, nextVisited, depth + 1);
      if (source.type === "import")
        return { type: "import", module: source.module, imported: member };
      if (source.type !== "global") return unknownBinding;
      if (
        source.name === "globalThis" ||
        source.name === "window" ||
        source.name === "self"
      )
        return { type: "global", name: member };
      return { type: "global", name: `${source.name}.${member}` };
    }
    return { type: "global", name };
  };

  return (node: Node): Binding => resolve(node, new Set(), 0);
};

export const isTestFile = (context: object): boolean => {
  const filename = filenameForContext(context);
  return /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec)\.[^/]+)$/u.test(
    filename,
  );
};

export const testOnlyPlugin = (
  name: string,
  messageId: string,
  message: string,
  makeVisitors: (
    report: (node: Node) => void,
    getScope: (node: Node) => Scope,
  ) => Record<string, (node: Node) => void>,
) =>
  eslintCompatPlugin({
    meta: { name },
    rules: {
      [name]: {
        meta: { type: "problem", messages: { [messageId]: message } },
        create(context) {
          if (!isTestFile(context)) return {};
          return makeVisitors(
            (node) => context.report({ node, messageId }),
            (node) => {
              if (!isScopeNode(node))
                throw new Error(
                  `Expected an oxlint AST node, got ${node.type}`,
                );
              return context.sourceCode.getScope(node);
            },
          );
        },
      },
    },
  });
