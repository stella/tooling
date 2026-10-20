// Shared AST helpers for the rules in this folder.
//
// Oxlint plugin AST nodes are passed in untyped. Each helper narrows from
// `unknown` so rule files can call them without per-call type ceremony or
// shared type-import boilerplate.

import type { ESTree, Ranged, Scope, Variable } from "@oxlint/plugins";

export type AstNode = Ranged & { type: string } & Record<string, unknown>;

type FilenameContext = {
  filename?: string;
  getFilename?: () => string;
};

export const filenameForContext = (context: FilenameContext): string =>
  (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");

export const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof (node as { type: unknown }).type === "string" &&
  "range" in node;

export const isIdentifier = (
  node: unknown,
  name?: string,
): node is AstNode & { type: "Identifier"; name: string } => {
  if (!isAstNode(node) || node.type !== "Identifier") {
    return false;
  }
  if (typeof node.name !== "string") {
    return false;
  }
  return name === undefined || node.name === name;
};

export const isStringLiteral = (
  node: unknown,
): node is AstNode & { type: "Literal"; value: string } =>
  isAstNode(node) && node.type === "Literal" && typeof node.value === "string";

// Resolve the static name of a Property or MemberExpression key:
// Identifier.name or string-Literal.value. Returns null for computed keys
// driven by a non-literal expression.
export const getPropertyName = (node: unknown): string | null => {
  if (isIdentifier(node)) {
    return node.name;
  }
  if (isStringLiteral(node)) {
    return node.value;
  }
  return null;
};

export const staticStringValue = (node: unknown): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null) return null;
  node = expression;
  if (isStringLiteral(node)) return node.value;
  if (
    !isAstNode(node) ||
    node.type !== "TemplateLiteral" ||
    !Array.isArray(node.expressions) ||
    node.expressions.length !== 0 ||
    !Array.isArray(node.quasis)
  )
    return null;
  const quasi = node.quasis.at(0);
  if (!isAstNode(quasi)) return null;
  const value = quasi.value;
  const cooked =
    typeof value === "object" && value !== null
      ? Reflect.get(value, "cooked")
      : undefined;
  return typeof cooked === "string" ? cooked : null;
};

export const memberPropertyName = (node: unknown): string | null => {
  if (!isAstNode(node) || node.type !== "MemberExpression") {
    return null;
  }
  if (node.computed !== true) {
    return getPropertyName(node.property);
  }
  return staticStringValue(node.property);
};

export const invokedCallee = (node: unknown): AstNode | null => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return null;
  }
  const callee = unwrapExpression(node.callee);
  if (!isAstNode(callee)) {
    return null;
  }
  if (
    callee.type === "SequenceExpression" &&
    Array.isArray(callee.expressions)
  ) {
    return unwrapExpression(callee.expressions.at(-1));
  }
  if (
    callee.type === "MemberExpression" &&
    (memberPropertyName(callee) === "call" ||
      memberPropertyName(callee) === "apply")
  ) {
    return unwrapExpression(callee.object);
  }
  return callee;
};

// Match `<object>.<property>` member access where both halves are
// Identifiers and the access is not computed.
export const isMemberAccess = (
  node: unknown,
  object: string,
  property: string,
): boolean =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  node.computed === false &&
  isIdentifier(node.object, object) &&
  isIdentifier(node.property, property);

// Match `CallExpression` whose callee is an Identifier with the given name.
export const isCallTo = (node: unknown, name: string): boolean =>
  isAstNode(node) &&
  node.type === "CallExpression" &&
  isIdentifier(node.callee, name);

// Resolve the dot-notation name of a callee: an Identifier, or a
// non-computed MemberExpression chain (e.g. `t.String`, `Schema.is`,
// `process.stderr.write`). Returns null when the chain is computed
// or the property name itself can't be resolved.
//
// If the chain is rooted at a non-Identifier expression (e.g. `foo().bar`),
// returns the bare property name ("bar") rather than null. Callers that
// match the result against a fixed allowlist must consider whether they
// need to distinguish `foo().createSafeHandler` from `createSafeHandler`.
export const getCalleeName = (callee: unknown): string | null => {
  if (isIdentifier(callee)) {
    return callee.name;
  }
  if (!isAstNode(callee) || callee.type !== "MemberExpression") {
    return null;
  }
  if (callee.computed !== false) {
    return null;
  }
  const objectName = getCalleeName(callee.object);
  const propertyName = getPropertyName(callee.property);
  if (propertyName === null) {
    return null;
  }
  return objectName === null ? propertyName : `${objectName}.${propertyName}`;
};

// Peel TS-only wrapping nodes so a shape check sees the underlying
// expression. Returns the original node when no wrapping is present.
export const unwrapExpression = (node: unknown): AstNode | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "ChainExpression"
  ) {
    return unwrapExpression(node.expression);
  }
  return node;
};

export type LiteralArgumentResolution =
  | { status: "known"; args: unknown[] }
  | { status: "opaque"; args: unknown[]; spread: unknown; tail: unknown[] };

// Expand literal array spreads and retain unresolved spread nodes in sequence.
// Positional readers use only `args`, the prefix before the first barrier;
// source inspectors can still inspect later entries in `tail`.
export const resolveLiteralArraySpreads = (
  args: unknown[],
): LiteralArgumentResolution => {
  const expanded: unknown[] = [];
  const append = (argument: unknown): void => {
    if (!isAstNode(argument) || argument.type !== "SpreadElement") {
      expanded.push(argument);
      return;
    }
    const expression = unwrapExpression(argument.argument);
    if (
      expression?.type !== "ArrayExpression" ||
      !Array.isArray(expression.elements)
    ) {
      expanded.push(argument);
      return;
    }
    for (const element of expression.elements) append(element);
  };
  for (const argument of args) append(argument);
  const barrierIndex = expanded.findIndex(
    (argument) => isAstNode(argument) && argument.type === "SpreadElement",
  );
  if (barrierIndex === -1) return { status: "known", args: expanded };
  const spread = expanded.at(barrierIndex);
  return {
    status: "opaque",
    args: expanded.slice(0, barrierIndex),
    spread,
    tail: expanded.slice(barrierIndex + 1),
  };
};

// Resolve an ImportSpecifier's imported binding name (Identifier.name or
// string-Literal.value). Returns null when the specifier shape is unexpected.
export const getImportedName = (specifier: unknown): string | null => {
  if (!isAstNode(specifier) || specifier.type !== "ImportSpecifier") {
    return null;
  }
  const imported = specifier.imported;
  if (isIdentifier(imported)) {
    return imported.name;
  }
  if (isStringLiteral(imported)) {
    return imported.value;
  }
  return null;
};

// Resolve an ImportSpecifier's local binding name. This differs from
// getImportedName for aliased imports such as `import { source as local }`.
export const getImportLocalName = (specifier: unknown): string | null => {
  if (!isAstNode(specifier) || specifier.type !== "ImportSpecifier") {
    return null;
  }
  return isIdentifier(specifier.local) ? specifier.local.name : null;
};

// An Identifier the parser emitted as a value reference (it carries a range,
// which synthetic name nodes do not).
export const isIdentifierReference = (
  node: unknown,
): node is ESTree.IdentifierReference =>
  isIdentifier(node) && Array.isArray(node.range);

export type ScopeContext = {
  sourceCode: { getScope: (node: ESTree.Node) => Scope };
};

const resolveVariable = (
  context: ScopeContext,
  identifier: ESTree.IdentifierReference,
): Variable | null => {
  let scope: Scope | null = context.sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
};

const isSingleAssignment = (variable: Variable): boolean =>
  variable.references.every(
    (reference) => !reference.isWrite() || reference.init,
  );

type ImportedBinding = { source: string; imported: string };
const NAMESPACE_IMPORT = "*";

const memberOfNamespace = (
  base: ImportedBinding | null,
  property: string | null,
): ImportedBinding | null =>
  base?.imported === NAMESPACE_IMPORT && property !== null
    ? { source: base.source, imported: property }
    : null;

const bindingFromVariable = (
  context: ScopeContext,
  variable: Variable,
  seen: Set<unknown>,
): ImportedBinding | null => {
  const definition = variable.defs.at(0);
  if (variable.defs.length !== 1 || definition === undefined) {
    return null;
  }
  const node: unknown = definition.node;
  if (definition.type === "ImportBinding") {
    const declaration: unknown = definition.parent;
    if (
      !isAstNode(node) ||
      node.importKind === "type" ||
      !isAstNode(declaration) ||
      declaration.type !== "ImportDeclaration" ||
      declaration.importKind === "type" ||
      !isStringLiteral(declaration.source)
    ) {
      return null;
    }
    const source = declaration.source.value;
    if (node.type === "ImportNamespaceSpecifier") {
      return { source, imported: NAMESPACE_IMPORT };
    }
    if (node.type === "ImportDefaultSpecifier") {
      return { source, imported: "default" };
    }
    const imported = getImportedName(node);
    return imported === null ? null : { source, imported };
  }
  if (
    definition.type !== "Variable" ||
    !isAstNode(node) ||
    node.type !== "VariableDeclarator" ||
    !isSingleAssignment(variable) ||
    !isIdentifier(node.id)
  ) {
    return null;
  }
  return resolveImportedExpressionForEnforcement(context, node.init, seen);
};

// The module export an expression evaluates to, or null for a local,
// parameter, call result, or unresolved global.
export const resolveImportedExpressionForEnforcement = (
  context: ScopeContext,
  node: unknown,
  seen = new Set<unknown>(),
): ImportedBinding | null => {
  const expression = unwrapExpression(node);
  if (!isAstNode(expression) || seen.has(expression)) {
    return null;
  }
  seen.add(expression);
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    return variable === null
      ? null
      : bindingFromVariable(context, variable, seen);
  }
  if (expression.type === "MemberExpression") {
    const base = resolveImportedExpressionForEnforcement(
      context,
      expression.object,
      seen,
    );
    return memberOfNamespace(base, memberPropertyName(expression));
  }
  return null;
};
