# stella/stella source snapshot at d78d0b901f89bb3b979375dee5a7bdd29ce325d7

## .oxlint-plugins/no-object-url-leak.ts

````ts
import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Ranged } from "@oxlint/plugins";
// Require every locally created Blob URL to have a matching revocation.
//
// URL.createObjectURL pins its Blob/File until URL.revokeObjectURL receives
// that produced value. This rule follows clear local ownership shapes: a URL
// held by one identifier, immutable aliases of that identifier, and cleanup
// callbacks that close over it. Escaped, discarded, or reassigned results are
// not considered disposed. Binding-aware global checks avoid matching a
// locally shadowed URL/window/globalThis object.

import {
  abruptCompletionTarget,
  getPropertyName,
  isAstNode,
  isIdentifier,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const RULE_NAME = "no-object-url-leak";
const GLOBAL_HOST_NAMES = new Set(["globalThis", "self", "window"]);
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const LOOP_TYPES = new Set([
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "WhileStatement",
]);
const CONDITIONAL_EXECUTION_TYPES = new Set([
  "CatchClause",
  "ConditionalExpression",
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "IfStatement",
  "LogicalExpression",
  "SwitchCase",
  "WhileStatement",
]);

type ScopeVariable = {
  defs: {
    node: unknown;
    parent: unknown;
    type: string;
  }[];
};

type Creation = {
  binding: ScopeVariable | null;
  node: Ranged;
  owner: object | null;
  position: number;
};

type Revocation = {
  aliasPositions: number[];
  argumentBinding: ScopeVariable | null;
  binding: ScopeVariable | null;
  node: Ranged;
  position: number;
  revokedCreation: object | null;
};

const nodePosition = (node: unknown): number => {
  if (
    !isAstNode(node) ||
    !Array.isArray(node.range) ||
    typeof node.range.at(0) !== "number"
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return node.range.at(0) ?? Number.POSITIVE_INFINITY;
};

const staticMemberName = (node: unknown): string | null => {
  const member = unwrapExpression(node);
  if (member?.type !== "MemberExpression") {
    return null;
  }
  return getPropertyName(member.property);
};

const nearestFunction = (node: unknown): AstNode | null => {
  let current = isAstNode(node) ? node.parent : null;
  while (isAstNode(current)) {
    if (FUNCTION_TYPES.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
};

const isNestedFunction = (
  candidate: AstNode | null,
  owner: AstNode | null,
): boolean => {
  if (candidate === null || candidate === owner) {
    return false;
  }
  let current: unknown = candidate.parent;
  while (isAstNode(current)) {
    if (current === owner || (owner === null && current.type === "Program")) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

type StatementSite = {
  block: AstNode;
  statement: AstNode;
};

const statementSite = (node: unknown): StatementSite | null => {
  let current = isAstNode(node) ? node : null;
  while (current !== null) {
    const parent = isAstNode(current.parent) ? current.parent : null;
    if (
      parent !== null &&
      (parent.type === "BlockStatement" || parent.type === "Program") &&
      Array.isArray(parent.body) &&
      parent.body.includes(current)
    ) {
      return { block: parent, statement: current };
    }
    current = parent;
  }
  return null;
};

const abruptCompletionBypasses = (
  node: AstNode,
  destination: unknown,
): boolean => {
  if (node.type === "ReturnStatement" || node.type === "ThrowStatement") {
    return true;
  }
  const target = abruptCompletionTarget(node);
  return target !== null && isDescendantOf(destination, target);
};

const containsBypassingAbruptCompletion = (
  node: unknown,
  destination: unknown,
  root: unknown = node,
  seen = new Set<unknown>(),
): boolean => {
  if (!isAstNode(node) || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (node !== root && FUNCTION_TYPES.has(node.type)) {
    return false;
  }
  if (
    (node.type === "BreakStatement" ||
      node.type === "ContinueStatement" ||
      node.type === "ReturnStatement" ||
      node.type === "ThrowStatement") &&
    abruptCompletionBypasses(node, destination)
  ) {
    return true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      if (
        value.some((child) =>
          containsBypassingAbruptCompletion(child, destination, root, seen),
        )
      ) {
        return true;
      }
      continue;
    }
    if (containsBypassingAbruptCompletion(value, destination, root, seen)) {
      return true;
    }
  }
  return false;
};

const isUnconditionallyExecuted = (
  node: unknown,
  statement: AstNode,
): boolean => {
  let child = isAstNode(node) ? node : null;
  while (child !== null && child !== statement) {
    const parent = isAstNode(child.parent) ? child.parent : null;
    if (parent === null) {
      return false;
    }
    if (parent.type === "TryStatement") {
      if (parent.finalizer !== child) {
        return false;
      }
    } else if (CONDITIONAL_EXECUTION_TYPES.has(parent.type)) {
      return false;
    }
    child = parent;
  }
  return child === statement;
};

const isDescendantOf = (node: unknown, ancestor: unknown): boolean => {
  let current = isAstNode(node) ? node : null;
  while (current !== null) {
    if (current === ancestor) {
      return true;
    }
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return false;
};

const repeatingLoopForNode = (node: unknown): AstNode | null => {
  let child = isAstNode(node) ? node : null;
  while (child !== null) {
    const parent = isAstNode(child.parent) ? child.parent : null;
    if (parent === null || FUNCTION_TYPES.has(parent.type)) {
      return null;
    }
    if (
      LOOP_TYPES.has(parent.type) &&
      (parent.type !== "ForStatement" || parent.init !== child)
    ) {
      return parent;
    }
    child = parent;
  }
  return null;
};

const isReturnedCleanupFunction = (
  functionNode: AstNode,
  ownerFunction: AstNode | null,
): boolean => {
  let child = functionNode;
  while (child !== ownerFunction) {
    const parent = isAstNode(child.parent) ? child.parent : null;
    if (parent === null) {
      return false;
    }
    if (parent.type === "ReturnStatement") {
      return parent.argument === child;
    }
    child = parent;
  }
  return false;
};

const functionAlwaysReachesNode = (
  functionNode: AstNode,
  node: unknown,
): boolean => {
  if (!isAstNode(functionNode.body)) {
    return false;
  }
  if (functionNode.body.type !== "BlockStatement") {
    return isDescendantOf(node, functionNode.body);
  }
  const revocationSite = statementSite(node);
  if (
    revocationSite === null ||
    revocationSite.block !== functionNode.body ||
    !isUnconditionallyExecuted(node, revocationSite.statement) ||
    !Array.isArray(functionNode.body.body)
  ) {
    return false;
  }
  const revocationIndex = functionNode.body.body.indexOf(
    revocationSite.statement,
  );
  return (
    revocationIndex !== -1 &&
    !functionNode.body.body
      .slice(0, revocationIndex)
      .some((statement) => containsBypassingAbruptCompletion(statement, node))
  );
};

const isRevokedByEnclosingFinally = (
  creation: Creation,
  revocation: Revocation,
): boolean => {
  let child = isAstNode(revocation.node) ? revocation.node : null;
  while (child !== null) {
    const parent = isAstNode(child.parent) ? child.parent : null;
    if (parent?.type === "TryStatement" && parent.finalizer === child) {
      if (!isUnconditionallyExecuted(revocation.node, child)) {
        return false;
      }
      if (isDescendantOf(creation.node, parent.block)) {
        return true;
      }
      const creationSite = statementSite(creation.node);
      const trySite = statementSite(parent);
      if (
        creationSite === null ||
        trySite === null ||
        creationSite.block !== trySite.block ||
        !Array.isArray(creationSite.block.body)
      ) {
        return false;
      }
      const creationIndex = creationSite.block.body.indexOf(
        creationSite.statement,
      );
      const tryIndex = creationSite.block.body.indexOf(trySite.statement);
      return (
        creationIndex !== -1 &&
        tryIndex > creationIndex &&
        !creationSite.block.body
          .slice(creationIndex + 1, tryIndex)
          .some((statement) =>
            containsBypassingAbruptCompletion(statement, revocation.node),
          )
      );
    }
    child = parent;
  }
  return false;
};

const isImmutablePerIterationBinding = (
  binding: ScopeVariable | null,
  repeatingLoop: AstNode,
  creationFunction: AstNode | null,
): boolean => {
  if (!isAstNode(repeatingLoop.body)) {
    return false;
  }
  return (
    binding?.defs.some(
      (definition) =>
        definition.type === "Variable" &&
        isAstNode(definition.node) &&
        definition.node.type === "VariableDeclarator" &&
        isAstNode(definition.parent) &&
        definition.parent.type === "VariableDeclaration" &&
        definition.parent.kind === "const" &&
        nearestFunction(definition.node) === creationFunction &&
        isDescendantOf(definition.node, repeatingLoop.body),
    ) === true
  );
};

const revocationCoversCreation = (
  creation: Creation,
  revocation: Revocation,
  callbackRegistrationSites: AstNode[],
): boolean => {
  const creationFunction = nearestFunction(creation.node);
  const revocationFunction = nearestFunction(revocation.node);
  const usesReturnedCleanup = isNestedFunction(
    revocationFunction,
    creationFunction,
  );
  const repeatingLoop = repeatingLoopForNode(creation.node);
  const isReturnedCleanup =
    usesReturnedCleanup &&
    revocationFunction !== null &&
    isReturnedCleanupFunction(revocationFunction, creationFunction);
  if (
    repeatingLoop !== null &&
    usesReturnedCleanup &&
    !isReturnedCleanup &&
    callbackRegistrationSites.length > 0 &&
    !isImmutablePerIterationBinding(
      revocation.argumentBinding,
      repeatingLoop,
      creationFunction,
    )
  ) {
    return false;
  }
  if (
    isRevokedByEnclosingFinally(creation, revocation) &&
    (repeatingLoop === null || isDescendantOf(revocation.node, repeatingLoop))
  ) {
    return true;
  }
  if (
    usesReturnedCleanup &&
    (revocationFunction === null ||
      !functionAlwaysReachesNode(revocationFunction, revocation.node))
  ) {
    return false;
  }
  const coverageNodes = usesReturnedCleanup
    ? isReturnedCleanup
      ? [revocationFunction]
      : callbackRegistrationSites
    : [revocation.node];

  return coverageNodes.some((coverageNode) => {
    if (
      repeatingLoop !== null &&
      !isDescendantOf(coverageNode, repeatingLoop)
    ) {
      return false;
    }
    const creationSite = statementSite(creation.node);
    const revocationSite = statementSite(coverageNode);
    if (
      creationSite === null ||
      revocationSite === null ||
      creationSite.block !== revocationSite.block ||
      !isUnconditionallyExecuted(coverageNode, revocationSite.statement) ||
      !Array.isArray(creationSite.block.body)
    ) {
      return false;
    }

    const creationIndex = creationSite.block.body.indexOf(
      creationSite.statement,
    );
    const revocationIndex = creationSite.block.body.indexOf(
      revocationSite.statement,
    );
    if (creationIndex === -1 || revocationIndex <= creationIndex) {
      return false;
    }
    return !creationSite.block.body
      .slice(creationIndex + 1, revocationIndex)
      .some((statement) =>
        containsBypassingAbruptCompletion(statement, coverageNode),
      );
  });
};

// Find the declaration/assignment that receives this value. Conditional and
// short-circuit expressions are transparent only when this creation can be
// the expression's owned result. A createObjectURL call on the left of `&&`
// produces a separate, truthy URL before the right operand runs, so it must
// not share the right operand's ownership slot. `||` and `??` select at most
// one created URL because object URLs are non-empty, non-nullish strings.
const wrapperCarriesCreatedValue = (
  parent: AstNode,
  current: AstNode,
): boolean => {
  if (parent.type === "ConditionalExpression") {
    return parent.consequent === current || parent.alternate === current;
  }
  if (parent.type !== "LogicalExpression") {
    return false;
  }
  if (parent.operator === "&&") {
    return parent.right === current;
  }
  return (
    (parent.operator === "||" || parent.operator === "??") &&
    (parent.left === current || parent.right === current)
  );
};

const creationOwner = (creation) => {
  let current = creation;
  let parent = isAstNode(current.parent) ? current.parent : null;
  while (
    parent !== null &&
    (parent.type === "TSAsExpression" ||
      parent.type === "TSNonNullExpression" ||
      parent.type === "TSSatisfiesExpression" ||
      parent.type === "TSTypeAssertion" ||
      wrapperCarriesCreatedValue(parent, current))
  ) {
    current = parent;
    parent = isAstNode(current.parent) ? current.parent : null;
  }
  if (
    parent?.type === "VariableDeclarator" &&
    parent.init === current &&
    isIdentifier(parent.id)
  ) {
    return { identifier: parent.id, owner: parent };
  }
  if (
    parent?.type === "AssignmentExpression" &&
    parent.right === current &&
    isIdentifier(parent.left)
  ) {
    return { identifier: parent.left, owner: parent };
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          noObjectUrlLeak:
            "This URL.createObjectURL() result is not provably revoked. " +
            "Store it in a local variable and pass that same value to " +
            "URL.revokeObjectURL() when ownership ends.",
        },
      },
      createOnce(context) {
        const creations: Creation[] = [];
        const revocations: Revocation[] = [];
        const assignments = new Map<ScopeVariable, number[]>();
        const callbackRegistrations = new Map<ScopeVariable, AstNode[]>();

        const resolveInScope = (identifier): ScopeVariable | null =>
          resolveVariable(context, identifier);

        const isGlobalReference = (node: unknown, name: string): boolean => {
          if (!isIdentifier(node, name)) {
            return false;
          }
          const variable = resolveInScope(node);
          return variable === null || variable.defs.length === 0;
        };

        const isUrlNamespace = (node: unknown): boolean => {
          const expression = unwrapExpression(node);
          if (expression === null) {
            return false;
          }
          if (isIdentifier(expression, "URL")) {
            return isGlobalReference(expression, "URL");
          }
          if (
            expression.type !== "MemberExpression" ||
            staticMemberName(expression) !== "URL"
          ) {
            return false;
          }
          const host = unwrapExpression(expression.object);
          return (
            isIdentifier(host) &&
            GLOBAL_HOST_NAMES.has(host.name) &&
            isGlobalReference(host, host.name)
          );
        };

        const isUrlMethodCall = (node: unknown, method: string): boolean => {
          const call = unwrapExpression(node);
          if (call?.type !== "CallExpression") {
            return false;
          }
          const callee = unwrapExpression(call.callee);
          return (
            callee?.type === "MemberExpression" &&
            staticMemberName(callee) === method &&
            isUrlNamespace(callee.object)
          );
        };

        const canonicalBindingInfo = (
          node: unknown,
          visited = new Set<ScopeVariable>(),
        ): {
          aliasPositions: number[];
          binding: ScopeVariable;
        } | null => {
          const expression = unwrapExpression(node);
          if (!isIdentifier(expression)) {
            return null;
          }
          const variable = resolveInScope(expression);
          if (variable === null) {
            return null;
          }
          if (visited.has(variable)) {
            return { aliasPositions: [], binding: variable };
          }
          visited.add(variable);
          for (const definition of variable.defs) {
            if (
              definition.type !== "Variable" ||
              !isAstNode(definition.node) ||
              definition.node.type !== "VariableDeclarator" ||
              !isAstNode(definition.parent) ||
              definition.parent.type !== "VariableDeclaration" ||
              definition.parent.kind !== "const"
            ) {
              continue;
            }
            const aliasedBinding = canonicalBindingInfo(
              definition.node.init,
              visited,
            );
            if (aliasedBinding !== null) {
              return {
                aliasPositions: [
                  ...aliasedBinding.aliasPositions,
                  nodePosition(definition.node),
                ],
                binding: aliasedBinding.binding,
              };
            }
          }
          return { aliasPositions: [], binding: variable };
        };

        const canonicalBinding = (node: unknown): ScopeVariable | null =>
          canonicalBindingInfo(node)?.binding ?? null;

        const directRevokedCreation = (argument) => {
          const expression = unwrapExpression(argument);
          return expression !== null &&
            isUrlMethodCall(expression, "createObjectURL")
            ? expression
            : null;
        };

        const cleanupFunctionBinding = (
          node: AstNode | null,
        ): ScopeVariable | null => {
          if (node === null) {
            return null;
          }
          const parent = isAstNode(node.parent) ? node.parent : null;
          if (
            parent?.type !== "VariableDeclarator" ||
            parent.init !== node ||
            !isIdentifier(parent.id)
          ) {
            return null;
          }
          return resolveInScope(parent.id);
        };

        const recordTimerCallbackRegistration = (node): void => {
          const callee = unwrapExpression(node.callee);
          if (
            !isIdentifier(callee, "setTimeout") ||
            !isGlobalReference(callee, "setTimeout") ||
            !Array.isArray(node.arguments)
          ) {
            return;
          }
          const callbackBinding = canonicalBinding(node.arguments.at(0));
          if (callbackBinding === null) {
            return;
          }
          const registrations =
            callbackRegistrations.get(callbackBinding) ?? [];
          registrations.push(node);
          callbackRegistrations.set(callbackBinding, registrations);
        };

        const cleanupCallbackRegistrations = (node: unknown): AstNode[] => {
          const binding = cleanupFunctionBinding(nearestFunction(node));
          return binding === null
            ? []
            : (callbackRegistrations.get(binding) ?? []);
        };

        const recordAssignment = (node): void => {
          if (!isIdentifier(node.left)) {
            return;
          }
          const variable = resolveInScope(node.left);
          if (variable === null) {
            return;
          }
          const positions = assignments.get(variable) ?? [];
          positions.push(nodePosition(node));
          assignments.set(variable, positions);
        };

        const hasInterveningAssignment = (
          binding: ScopeVariable,
          creationPosition: number,
          revocationPosition: number,
        ): boolean =>
          (assignments.get(binding) ?? []).some(
            (position) =>
              position > creationPosition && position < revocationPosition,
          );

        return {
          before() {
            creations.length = 0;
            revocations.length = 0;
            assignments.clear();
            callbackRegistrations.clear();
            return context.sourceCode.text.includes("createObjectURL");
          },
          AssignmentExpression(node) {
            recordAssignment(node);
          },
          CallExpression(node) {
            recordTimerCallbackRegistration(node);
            if (isUrlMethodCall(node, "createObjectURL")) {
              const owner = creationOwner(node);
              creations.push({
                binding:
                  owner === null ? null : resolveInScope(owner.identifier),
                node,
                owner: owner?.owner ?? null,
                position: nodePosition(node),
              });
              return;
            }
            if (!isUrlMethodCall(node, "revokeObjectURL")) {
              return;
            }
            const argument = Array.isArray(node.arguments)
              ? node.arguments.at(0)
              : null;
            const bindingInfo = canonicalBindingInfo(argument);
            revocations.push({
              aliasPositions: bindingInfo?.aliasPositions ?? [],
              argumentBinding: isIdentifier(unwrapExpression(argument))
                ? resolveInScope(unwrapExpression(argument))
                : null,
              binding: bindingInfo?.binding ?? null,
              node,
              position: nodePosition(node),
              revokedCreation: directRevokedCreation(argument),
            });
          },
          "Program:exit"() {
            const ownerSets = new Map<ScopeVariable, Set<object>>();
            for (const creation of creations) {
              if (creation.binding === null || creation.owner === null) {
                continue;
              }
              const owners = ownerSets.get(creation.binding) ?? new Set();
              owners.add(creation.owner);
              ownerSets.set(creation.binding, owners);
            }

            for (const creation of creations) {
              const directlyRevoked = revocations.some(
                ({ revokedCreation }) => revokedCreation === creation.node,
              );
              if (directlyRevoked) {
                continue;
              }
              if (creation.binding !== null) {
                const binding = creation.binding;
                const hasOneOwnershipWrite = ownerSets.get(binding)?.size === 1;
                const matchingRevocation = revocations.find((revocation) => {
                  if (revocation.binding !== binding) {
                    return false;
                  }
                  if (
                    revocation.aliasPositions.some(
                      (position) => position < creation.position,
                    )
                  ) {
                    return false;
                  }
                  return (
                    (revocation.position > creation.position ||
                      isNestedFunction(
                        nearestFunction(revocation.node),
                        nearestFunction(creation.node),
                      )) &&
                    revocationCoversCreation(
                      creation,
                      revocation,
                      cleanupCallbackRegistrations(revocation.node),
                    ) &&
                    !hasInterveningAssignment(
                      binding,
                      creation.position,
                      revocation.position,
                    )
                  );
                });
                if (hasOneOwnershipWrite && matchingRevocation !== undefined) {
                  continue;
                }
              }
              context.report({
                node: creation.node,
                messageId: "noObjectUrlLeak",
              });
            }
          },
        };
      },
    },
  },
});
````

## .oxlint-plugins/__fixtures__/no-object-url-leak.fixture.ts

````ts
// Passive regression fixture for `no-object-url-leak/no-object-url-leak`.
//
// Rule-specific disables mark creations the rule MUST reject. If detection
// regresses, unused-directive reporting fails this fixture. Unannotated calls
// cover the supported local disposal and shadowing patterns.

declare const blob: Blob;
declare const blobs: readonly Blob[];
declare const condition: boolean;
declare const existingObjectUrl: string;
declare const mode: "keep" | "skip";

// MUST flag: an escaped Blob URL has no visible owner or cleanup.
export const escapedUrl = () =>
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: returned Blob URL has no local revocation
  URL.createObjectURL(blob);

// MUST flag: binding the result without revoking it still pins the Blob.
export const retainedUrl = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: local Blob URL is never revoked
  const url = URL.createObjectURL(blob);
  return url;
};

// MUST flag: explicit globalThis access is the same browser API.
export const explicitGlobalUrl = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: explicit global namespace cannot bypass disposal
  globalThis.URL.createObjectURL(blob);
};

// MUST flag: revoking an earlier value does not dispose a later assignment.
export const revokeBeforeCreate = () => {
  let url = "blob:old";
  URL.revokeObjectURL(url);
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: revocation precedes this creation
  url = URL.createObjectURL(blob);
  return url;
};

// MUST flag: an immutable alias captured before the ownership write still
// points at the old value and cannot revoke the newly created URL.
export const staleAliasCleanup = () => {
  let url = "blob:old";
  const staleUrl = url;
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak, no-useless-assignment -- fixture: pre-creation alias cannot dispose the new assigned value
  url = URL.createObjectURL(blob);
  URL.revokeObjectURL(staleUrl);
};

// MUST flag: an early return can bypass the lexically later revocation.
export const conditionalEarlyReturn = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: cleanup does not cover the early-return path
  const url = URL.createObjectURL(blob);
  if (condition) {
    return;
  }
  URL.revokeObjectURL(url);
};

// MUST flag: conditional cleanup does not cover the false branch.
export const conditionalRevocation = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: cleanup is not guaranteed on every branch
  const url = URL.createObjectURL(blob);
  if (condition) {
    URL.revokeObjectURL(url);
  }
};

// MUST flag: an early return can bypass registration of the cleanup callback.
export const conditionalCleanupCallback = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: the returned cleanup does not cover the early-return path
  const url = URL.createObjectURL(blob);
  if (condition) {
    return () => undefined;
  }
  return () => URL.revokeObjectURL(url);
};

// MUST flag: an early return can bypass timer registration.
export const conditionalTimerRegistration = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: timer cleanup does not cover the early-return path
  const url = URL.createObjectURL(blob);
  const cleanup = () => URL.revokeObjectURL(url);
  if (condition) {
    return;
  }
  setTimeout(cleanup, 1000);
};

// MUST flag: registering a callback does not help when that callback can skip
// revocation internally.
export const conditionalTimerCleanup = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: callback cleanup is conditional
  const url = URL.createObjectURL(blob);
  const cleanup = () => {
    if (condition) {
      URL.revokeObjectURL(url);
    }
  };
  setTimeout(cleanup, 1000);
};

// MUST flag: each iteration overwrites the shared binding before an earlier
// timer callback necessarily runs, so every callback can observe only the
// latest URL.
export const sharedLoopBindingTimerCleanup = () => {
  let url: string;
  for (const currentBlob of blobs) {
    // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: deferred cleanup closes over a shared binding overwritten by the loop
    url = URL.createObjectURL(currentBlob);
    // oxlint-disable-next-line no-loop-func -- fixture: unsafe shared capture is the rule behavior under test
    const cleanup = () => URL.revokeObjectURL(url);
    setTimeout(cleanup, 1000);
  }
};

// MUST flag: a `finally` block must revoke on every path through the block.
export const conditionalFinallyCleanup = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: finally cleanup is conditional
  const url = URL.createObjectURL(blob);
  try {
    return;
  } finally {
    if (condition) {
      URL.revokeObjectURL(url);
    }
  }
};

// MUST flag: the left side of && is a distinct, truthy object URL. The right
// side becomes the assigned result, so revoking that result cannot free the
// first Blob.
export const accumulatingLogicalAnd = () => {
  const url =
    // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: logical AND creates two live ownership values
    URL.createObjectURL(blob) &&
    // The assigned right-side creation is revoked and must remain clean.
    URL.createObjectURL(blob);
  URL.revokeObjectURL(url);
};

// MUST flag: the URL created on the left of && is discarded when the logical
// expression selects a replacement string. Revoking that result cannot free
// the created Blob URL.
export const replacedLogicalAnd = () => {
  const url =
    // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: logical AND discards the created URL for a replacement value
    URL.createObjectURL(blob) && "replacement";
  URL.revokeObjectURL(url);
};

// MUST flag: a loop can overwrite the same ownership binding on every
// iteration; one revocation after the loop only disposes the final URL.
export const repeatedLoopWithPostCleanup = () => {
  let url = "blob:initial";
  for (const currentBlob of blobs)
    // oxlint-disable-next-line no-object-url-leak/no-object-url-leak, curly -- fixture: unbraced loop exposes the post-loop cleanup false proof
    url = URL.createObjectURL(currentBlob);
  URL.revokeObjectURL(url);
};

// MUST flag: a continue targeting the creation loop bypasses that iteration's
// lexically later cleanup.
export const outerContinueBypassesCleanup = () => {
  for (const currentBlob of blobs) {
    // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: outer-loop continue skips per-iteration cleanup
    const url = URL.createObjectURL(currentBlob);
    if (condition) {
      continue;
    }
    URL.revokeObjectURL(url);
  }
};

// MUST flag: labeled control targeting the creation loop also bypasses the
// current iteration's cleanup.
export const labeledBreakBypassesCleanup = () => {
  // oxlint-disable-next-line no-labels -- fixture: labeled outer-loop exit is the control-flow shape under test
  creationLoop: for (const currentBlob of blobs) {
    // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: labeled break exits before cleanup
    const url = URL.createObjectURL(currentBlob);
    for (const candidate of blobs) {
      if (condition && candidate === currentBlob) {
        // oxlint-disable-next-line no-labels -- fixture: labeled break targets the creation loop
        break creationLoop;
      }
    }
    URL.revokeObjectURL(url);
  }
};

export const labeledContinueBypassesCleanup = () => {
  // oxlint-disable-next-line no-labels -- fixture: labeled outer-loop continue is the control-flow shape under test
  creationLoop: for (const currentBlob of blobs) {
    // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: labeled continue skips cleanup
    const url = URL.createObjectURL(currentBlob);
    for (const candidate of blobs) {
      if (condition && candidate === currentBlob) {
        // oxlint-disable-next-line no-labels -- fixture: labeled continue targets the creation loop
        continue creationLoop;
      }
    }
    URL.revokeObjectURL(url);
  }
};

// Allowed: direct local pairing with the same binding.
// expect-clean: no-object-url-leak/no-object-url-leak
export const downloadUrl = () => {
  const url = URL.createObjectURL(blob);
  URL.revokeObjectURL(url);
};

// Allowed: immutable aliases preserve the same produced value.
export const aliasedCleanup = () => {
  const url = window.URL.createObjectURL(blob);
  const cleanupUrl = url;
  window.URL.revokeObjectURL(cleanupUrl);
};

// Allowed: a returned cleanup callback closes over the created URL.
export const cleanupCallback = () => {
  const url = URL.createObjectURL(blob);
  return () => URL.revokeObjectURL(url);
};

// Allowed: an unconditionally registered timer provides bounded cleanup for a
// resource that must outlive the current synchronous operation.
export const scheduledCleanup = () => {
  const url = URL.createObjectURL(blob);
  const cleanup = () => URL.revokeObjectURL(url);
  setTimeout(cleanup, 1000);
};

// Allowed: a const declared in the loop body is a fresh binding for every
// iteration, so each timer captures the URL created by that iteration.
export const scheduledPerIterationCleanup = () => {
  for (const currentBlob of blobs) {
    const url = URL.createObjectURL(currentBlob);
    const cleanup = () => URL.revokeObjectURL(url);
    setTimeout(cleanup, 1000);
  }
};

// Allowed: an immutable per-iteration alias snapshots an outer ownership
// binding before the next iteration overwrites it.
export const scheduledPerIterationAliasCleanup = () => {
  let url: string;
  for (const currentBlob of blobs) {
    url = URL.createObjectURL(currentBlob);
    const capturedUrl = url;
    const cleanup = () => URL.revokeObjectURL(capturedUrl);
    setTimeout(cleanup, 1000);
  }
};

// Allowed: nested-loop break/continue inside a returned cleanup callback do
// not bypass the callback's later revocation.
export const returnedCleanupWithNestedLoop = () => {
  const url = URL.createObjectURL(blob);
  return () => {
    for (const candidate of blobs) {
      if (candidate === blob) {
        continue;
      }
      break;
    }
    URL.revokeObjectURL(url);
  };
};

// Allowed: the same target-aware proof applies inside a registered timer
// cleanup callback.
export const timerCleanupWithNestedLoop = () => {
  const url = URL.createObjectURL(blob);
  const cleanup = () => {
    for (const candidate of blobs) {
      if (candidate === blob) {
        continue;
      }
      break;
    }
    URL.revokeObjectURL(url);
  };
  setTimeout(cleanup, 1000);
};

// Allowed: conditional creation has one ownership write and revokes whichever
// branch produced the value.
export const conditionalCleanup = () => {
  const url = condition
    ? URL.createObjectURL(blob)
    : globalThis.URL.createObjectURL(blob);
  URL.revokeObjectURL(url);
};

// Allowed: object URLs are truthy and non-nullish strings, so the right sides
// of || and ?? are mutually exclusive fallbacks rather than accumulating
// ownership writes.
export const logicalFallbackCleanup = () => {
  const runtimeFallbackUrl =
    existingObjectUrl || globalThis.URL.createObjectURL(blob);
  URL.revokeObjectURL(runtimeFallbackUrl);
  const orUrl =
    URL.createObjectURL(blob) || globalThis.URL.createObjectURL(blob);
  URL.revokeObjectURL(orUrl);
  const nullishUrl =
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- fixture: exercise conservative ?? ownership handling
    URL.createObjectURL(blob) ?? globalThis.URL.createObjectURL(blob);
  URL.revokeObjectURL(nullishUrl);
};

// Allowed: `finally` revokes the URL even when the work exits abruptly.
export const finallyCleanup = () => {
  const url = URL.createObjectURL(blob);
  try {
    if (condition) {
      return;
    }
  } finally {
    URL.revokeObjectURL(url);
  }
};

// Allowed: a finally nested inside the creation loop runs once for every
// ownership write, including continue/return paths through that iteration.
export const perIterationFinallyCleanup = () => {
  for (const currentBlob of blobs) {
    const url = URL.createObjectURL(currentBlob);
    try {
      if (condition) {
        continue;
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }
};

// Allowed: a ForStatement initializer executes once, so one unconditional
// cleanup after the loop covers that ownership write.
export const forInitializerCleanup = () => {
  let url: string;
  let iteration = 0;
  for (url = URL.createObjectURL(blob); iteration < 1; iteration += 1) {
    void url;
  }
  URL.revokeObjectURL(url);
};

// Allowed: break/continue inside a nested loop and break inside a nested
// switch target those nested constructs; all paths still reach the outer
// iteration's later cleanup.
export const nestedAbruptCompletionsStillCleanUp = () => {
  for (const currentBlob of blobs) {
    const url = URL.createObjectURL(currentBlob);
    for (const candidate of blobs) {
      if (candidate === currentBlob) {
        continue;
      }
      break;
    }
    for (const candidate of blobs) {
      if (candidate === currentBlob) {
        break;
      }
    }
    switch (mode) {
      case "skip":
        break;
      case "keep":
        void currentBlob;
        break;
    }
    URL.revokeObjectURL(url);
  }
};

// Allowed: immediate create/revoke is unusual but does not retain the Blob.
export const immediateCleanup = () =>
  URL.revokeObjectURL(URL.createObjectURL(blob));

// Allowed: locally injected URL-shaped objects are not the browser global.
export const useInjectedUrl = (URL: {
  createObjectURL: (value: Blob) => string;
}) => URL.createObjectURL(blob);

// Allowed: a locally injected window is not the browser global host.
export const useInjectedWindow = (window: {
  URL: { createObjectURL: (value: Blob) => string };
}) => window.URL.createObjectURL(blob);
````

## .oxlint-plugins/__tests__/no-object-url-leak.test.ts

````ts
import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("reports discarded escaped and retained URLs", async () => {
  expect(
    await lintSingleRule(
      "no-object-url-leak",
      "URL.createObjectURL(blob);\nfunction escaped() { return globalThis.URL.createObjectURL(blob); }\nfunction retained() { const url = URL.createObjectURL(blob); return url; }",
      {},
    ),
  ).toEqual([1, 2, 3]);
});

test("requires revocation of the created value", async () => {
  expect(
    await lintSingleRule(
      "no-object-url-leak",
      "function wrong() { const url = URL.createObjectURL(blob); URL.revokeObjectURL(other); }",
      {},
    ),
  ).toEqual([1]);
});

test("rejects conditional and early return cleanup paths", async () => {
  expect(
    await lintSingleRule(
      "no-object-url-leak",
      "function conditional() { const url = URL.createObjectURL(blob); if (condition) URL.revokeObjectURL(url); }\nfunction early() { const url = URL.createObjectURL(blob); if (condition) return; URL.revokeObjectURL(url); }",
      {},
    ),
  ).toEqual([1, 2]);
});

test("accepts immutable aliases and returned cleanup ownership", async () => {
  expect(
    await lintSingleRule(
      "no-object-url-leak",
      "function direct() { const url = window.URL.createObjectURL(blob); const alias = url; window.URL.revokeObjectURL(alias); }\nfunction cleanup() { const url = URL.createObjectURL(blob); return () => URL.revokeObjectURL(url); }",
      {},
    ),
  ).toEqual([]);
});

test("accepts unconditional finally and scheduled cleanup", async () => {
  expect(
    await lintSingleRule(
      "no-object-url-leak",
      "function final() { const url = URL.createObjectURL(blob); try { consume(url); } finally { URL.revokeObjectURL(url); } }\nfunction scheduled() { const url = URL.createObjectURL(blob); const cleanup = () => URL.revokeObjectURL(url); setTimeout(cleanup, 1000); }",
      {},
    ),
  ).toEqual([]);
});

test("does not treat an overwritten binding as disposed", async () => {
  expect(
    await lintSingleRule(
      "no-object-url-leak",
      "function overwritten() { let url = URL.createObjectURL(blob); url = other; URL.revokeObjectURL(url); }",
      {},
    ),
  ).toEqual([1]);
});

test("respects local URL and host shadows", async () => {
  expect(
    await lintSingleRule(
      "no-object-url-leak",
      "function local(URL, window) { URL.createObjectURL(blob); window.URL.createObjectURL(blob); }",
      {},
    ),
  ).toEqual([]);
});
````

## .oxlint-plugins/no-first-observer-entry.ts

````ts
import {
  eslintCompatPlugin,
  type ESTree,
  type Variable,
} from "@oxlint/plugins";

import {
  isAstNode,
  isIdentifierReference,
  isSingleAssignment,
  memberPropertyName,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";
import type { ScopeContext } from "./utils.ts";

const OBSERVERS = new Set(["IntersectionObserver", "ResizeObserver"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "window"]);

type Callback = ESTree.ArrowFunctionExpression | ESTree.Function;

const isCallback = (node: unknown): node is Callback =>
  isAstNode(node) &&
  (node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration");

type ResolveCallbackOptions = {
  context: ScopeContext;
  node: unknown;
  seen?: Set<Variable>;
};
const resolveCallback = ({
  context,
  node,
  seen = new Set<Variable>(),
}: ResolveCallbackOptions): Callback | null => {
  const expression = unwrapExpression(node);
  if (isCallback(expression)) {
    return expression;
  }
  if (!isIdentifierReference(expression)) {
    return null;
  }
  const variable = resolveVariable(context, expression);
  if (!variable || seen.has(variable)) {
    return null;
  }
  seen.add(variable);
  const declaration = variable.defs.at(0)?.node;
  // A reassigned binding may hold another function when the observer is built.
  if (declaration?.type === "FunctionDeclaration") {
    return variable.defs.length === 1 && isSingleAssignment(variable)
      ? declaration
      : null;
  }
  return resolveCallback({ context, node: stableInitializer(variable), seen });
};

const isObserverConstructor = (context: ScopeContext, node: unknown) => {
  const callee = unwrapExpression(node);
  if (isIdentifierReference(callee)) {
    return (
      OBSERVERS.has(callee.name) &&
      !resolveVariable(context, callee)?.defs.length
    );
  }
  return (
    callee?.type === "MemberExpression" &&
    OBSERVERS.has(memberPropertyName(callee) ?? "") &&
    isIdentifierReference(callee.object) &&
    GLOBAL_OBJECTS.has(callee.object.name) &&
    !resolveVariable(context, callee.object)?.defs.length
  );
};

const isZero = (node: unknown) => {
  const expression = unwrapExpression(node);
  return expression?.type === "Literal" && expression.value === 0;
};

export default eslintCompatPlugin({
  meta: { name: "no-first-observer-entry" },
  rules: {
    "no-first-observer-entry": {
      meta: {
        type: "problem",
        messages: {
          latestRecord:
            "Decide from the latest observer record per target: use entries.at(-1) for one target, or the last entry for each target when observing several.",
        },
      },
      createOnce(context) {
        const parameters = new Set<Variable>();
        const candidates: {
          node: ESTree.Node;
          receiver: ESTree.IdentifierReference;
        }[] = [];
        return {
          before() {
            parameters.clear();
            candidates.length = 0;
          },
          NewExpression(node) {
            if (!isObserverConstructor(context, node.callee)) {
              return;
            }
            const callback = resolveCallback({
              context,
              node: node.arguments.at(0),
            });
            const parameter = callback?.params.at(0);
            const binding =
              parameter?.type === "AssignmentPattern"
                ? parameter.left
                : parameter;
            if (binding?.type === "ArrayPattern") {
              const firstBinding = binding.elements.at(0);
              if (firstBinding && firstBinding.type !== "RestElement") {
                context.report({ node: binding, messageId: "latestRecord" });
                return;
              }
            }
            if (!callback?.body || binding?.type !== "Identifier") {
              return;
            }
            const variable = context.sourceCode
              .getScope(callback.body)
              .set.get(binding.name);
            if (variable) {
              parameters.add(variable);
            }
          },
          MemberExpression(node) {
            if (
              node.computed &&
              isZero(node.property) &&
              isIdentifierReference(node.object)
            ) {
              candidates.push({ node, receiver: node.object });
            }
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              callee?.type === "MemberExpression" &&
              memberPropertyName(callee) === "at" &&
              isZero(node.arguments.at(0)) &&
              isIdentifierReference(callee.object)
            ) {
              candidates.push({ node, receiver: callee.object });
            }
          },
          VariableDeclarator(node) {
            const firstBinding =
              node.id.type === "ArrayPattern" ? node.id.elements.at(0) : null;
            if (
              firstBinding &&
              firstBinding.type !== "RestElement" &&
              isIdentifierReference(node.init)
            ) {
              candidates.push({ node: node.id, receiver: node.init });
            }
          },
          "Program:exit"() {
            // Named callbacks can occur before their observer construction.
            for (const { node, receiver } of candidates) {
              const variable = resolveVariable(context, receiver);
              if (variable && parameters.has(variable)) {
                context.report({ node, messageId: "latestRecord" });
              }
            }
          },
        };
      },
    },
  },
});
````

## .oxlint-plugins/__fixtures__/no-first-observer-entry.fixture.ts

````ts
export const staleIntersection = new IntersectionObserver((records) =>
  // oxlint-disable-next-line no-first-observer-entry/no-first-observer-entry -- fixture: the first queued record can be stale
  consume(records[0]),
);

export const staleResize = new ResizeObserver((measurements) =>
  // oxlint-disable-next-line no-first-observer-entry/no-first-observer-entry -- fixture: callback parameter spelling does not change record ordering
  consume(measurements.at(0)),
);

export const latestSingleTarget = new IntersectionObserver((records) =>
  // expect-clean: no-first-observer-entry/no-first-observer-entry
  consume(records.at(-1)),
);

export const latestPerTarget = new ResizeObserver((records) => {
  const latest = new Map<Element, ResizeObserverEntry>();
  for (const record of records) {
    latest.set(record.target, record);
  }
  // expect-clean: no-first-observer-entry/no-first-observer-entry
  consume(latest);
});
declare const consume: (value: unknown) => void;
````

## .oxlint-plugins/__tests__/no-first-observer-entry.test.ts

````ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  await lintSingleRule("no-first-observer-entry", source);

describe("observer callbacks decide from the latest record", () => {
  test("rejects first-record reads for either observer and any parameter name", async () => {
    expect(
      await lint(
        [
          "new IntersectionObserver((records) => consume(records[0]));",
          "new ResizeObserver(function (measurements) { consume(measurements.at(0)); });",
          "new window.IntersectionObserver((queue) => consume(queue?.at(0)));",
          'new globalThis.ResizeObserver((batch) => consume(batch["at"](0)));',
          "new ResizeObserver((records = []) => consume(records[0]));",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  test("follows named callbacks declared before or after construction and stable aliases", async () => {
    expect(
      await lint(
        [
          "const callback = (records) => consume(records[0]);",
          "const alias = callback; new ResizeObserver(alias);",
          "new IntersectionObserver(onIntersection);",
          "function onIntersection(records) { consume(records.at(0)); }",
        ].join("\n"),
      ),
    ).toEqual([1, 4]);
  });

  test("follows a function declaration only while its binding is never reassigned", async () => {
    // Reassigned before construction: the observer receives the latest callback.
    expect(
      await lint(
        [
          "function onResize(records) { consume(records[0]); }",
          "onResize = (records) => consume(records.at(-1));",
          "new ResizeObserver(onResize);",
        ].join("\n"),
      ),
    ).toEqual([]);
    // Reassigned after construction in source order: loops and closures can
    // still run the write first, so the declaration is not followed either.
    expect(
      await lint(
        [
          "new IntersectionObserver(onIntersection);",
          "onIntersection = (records) => consume(records.at(-1));",
          "function onIntersection(records) { consume(records[0]); }",
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(
      await lint(
        [
          "new IntersectionObserver(onIntersection);",
          "function onIntersection(records) { consume(records[0]); }",
        ].join("\n"),
      ),
    ).toEqual([2]);
  });

  test("rejects first-record destructuring in either observer callback", async () => {
    expect(
      await lint(
        [
          "new ResizeObserver(([first]) => consume(first));",
          "new IntersectionObserver(function ([entry, ...rest]) { consume(entry); });",
          "new ResizeObserver((entries) => { const [first] = entries; consume(first); });",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3]);
  });

  test("allows shadowed and non-first callback-body destructuring", async () => {
    expect(
      await lint(
        [
          "new ResizeObserver((entries) => { { const entries = unrelated; const [first] = entries; consume(first); } });",
          "new ResizeObserver((entries) => { const [, second] = entries; consume(second); });",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("allows rest destructuring of all observer entries", async () => {
    expect(
      await lint(
        [
          "new ResizeObserver(([...entries]) => consume(entries));",
          "new ResizeObserver((entries) => { const [...copy] = entries; consume(copy); });",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("tracks lexical bindings through nested callbacks without confusing shadowed arrays", async () => {
    expect(
      await lint(
        [
          "new ResizeObserver((records) => {",
          "  consume(() => records[0]);",
          "  consume((records) => records[0]);",
          "  { const records = unrelated; consume(records.at(0)); }",
          "});",
        ].join("\n"),
      ),
    ).toEqual([2]);
  });

  test("allows latest single-target records, per-target folding and unrelated arrays", async () => {
    expect(
      await lint(
        [
          "new IntersectionObserver((entries) => consume(entries.at(-1)));",
          "new ResizeObserver((entries) => { const latest = new Map(); for (const entry of entries) latest.set(entry.target, entry); consume(latest); });",
          "new ResizeObserver((entries) => consume(unrelated[0]));",
          "consume((entries) => entries.at(0));",
          "function local(ResizeObserver) { new ResizeObserver((entries) => entries[0]); }",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("the committed fixture plants violations and permits latest-per-target decisions", async () => {
    const fixture = readFileSync(
      new URL(
        "../__fixtures__/no-first-observer-entry.fixture.ts",
        import.meta.url,
      ),
      "utf-8",
    );
    const planted = fixture.replaceAll(
      /.*oxlint-disable-next-line.*\n/gu,
      "\n",
    );
    expect(planted).not.toBe(fixture);
    expect(await lint(fixture)).toEqual([]);
    const violations = fixture
      .split("\n")
      .flatMap((line, index) =>
        line.includes("oxlint-disable-next-line no-first-observer-entry/")
          ? [index + 2]
          : [],
      );
    expect(violations).toHaveLength(2);
    expect(await lint(planted)).toEqual(violations);
  });
});
````

## .oxlint-plugins/no-duplicate-jsx-sibling-key.ts

````ts
// React keys identify one child among its siblings. Reusing the same explicit
// key for two direct JSX children makes reconciliation ambiguous: a refresh,
// navigation, or conditional update can preserve, duplicate, or remove the
// wrong subtree.
//
// `react/jsx-key` requires keys for array-produced children and can detect
// duplicates in those arrays. It does not compare explicitly keyed static JSX
// siblings, which is the shape this rule owns.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { SourceCode } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import { isAstNode, unwrapExpression } from "./utils.ts";

const jsxAttributeName = (node: unknown): string | null =>
  isAstNode(node) &&
  node.type === "JSXIdentifier" &&
  typeof node.name === "string"
    ? node.name
    : null;

const openingElementOf = (node: unknown): AstNode | null =>
  isAstNode(node) &&
  node.type === "JSXElement" &&
  isAstNode(node.openingElement)
    ? node.openingElement
    : null;

const keyAttributeOf = (node: unknown): AstNode | null => {
  const openingElement = openingElementOf(node);
  if (openingElement === null || !Array.isArray(openingElement.attributes)) {
    return null;
  }
  return (
    openingElement.attributes.find(
      (attribute): attribute is AstNode =>
        isAstNode(attribute) &&
        attribute.type === "JSXAttribute" &&
        jsxAttributeName(attribute.name) === "key",
    ) ?? null
  );
};

const keySignature = (
  attribute: AstNode,
  sourceCode: SourceCode,
): string | null => {
  const value = attribute.value;
  if (!isAstNode(value)) {
    return "implicit:true";
  }
  if (value.type === "Literal") {
    return `literal:${JSON.stringify(value.value)}`;
  }
  if (value.type !== "JSXExpressionContainer") {
    return `jsx:${sourceCode.getText(value)}`;
  }
  const expression = unwrapExpression(value.expression);
  if (expression === null || expression.type === "JSXEmptyExpression") {
    return null;
  }
  if (expression.type === "Literal") {
    return `literal:${JSON.stringify(expression.value)}`;
  }
  return `expression:${sourceCode.getText(expression)}`;
};

const checkChildren = (node, context) => {
  if (!Array.isArray(node.children)) {
    return;
  }
  const seenSignatures = new Set<string>();
  for (const child of node.children) {
    const attribute = keyAttributeOf(child);
    if (attribute === null) {
      continue;
    }
    const signature = keySignature(attribute, context.sourceCode);
    if (signature === null) {
      continue;
    }
    if (seenSignatures.has(signature)) {
      context.report({ node: attribute, messageId: "duplicateSiblingKey" });
      continue;
    }
    seenSignatures.add(signature);
  }
};

export default eslintCompatPlugin({
  meta: { name: "no-duplicate-jsx-sibling-key" },
  rules: {
    "no-duplicate-jsx-sibling-key": {
      meta: {
        type: "problem",
        messages: {
          duplicateSiblingKey:
            "Direct JSX siblings must not share a key; give each child a distinct identity or remove unnecessary static keys.",
        },
      },
      createOnce(context) {
        return {
          JSXElement(node) {
            checkChildren(node, context);
          },
          JSXFragment(node) {
            checkChildren(node, context);
          },
        };
      },
    },
  },
});
````

## .oxlint-plugins/__fixtures__/no-duplicate-jsx-sibling-key.fixture.tsx

````ts
// Passive regression fixture for
// `no-duplicate-jsx-sibling-key/no-duplicate-jsx-sibling-key`.
//
// Suppressed lines must be reported; otherwise the unused-directive check
// fails. Unsuppressed examples define the allowed boundary.

const Panel = ({ key: _key }: { key?: string }) => <section />;
const workspaceId = "workspace";

export const _duplicateExpression = () => (
  <main>
    <Panel key={workspaceId} />
    {/* oxlint-disable-next-line no-duplicate-jsx-sibling-key/no-duplicate-jsx-sibling-key */}
    <Panel key={workspaceId} />
  </main>
);

export const _duplicateLiteral = () => (
  <>
    <Panel key="summary" />
    {/* oxlint-disable-next-line no-duplicate-jsx-sibling-key/no-duplicate-jsx-sibling-key */}
    <Panel key={"summary"} />
  </>
);

export const _distinctKeys = () => (
  <main>
    <Panel key={`case-law:${workspaceId}`} />
    {/* expect-clean: no-duplicate-jsx-sibling-key/no-duplicate-jsx-sibling-key */}
    <Panel key={`activity:${workspaceId}`} />
  </main>
);

export const _unkeyedStaticSiblings = () => (
  <main>
    <Panel />
    <Panel />
  </main>
);

export const _separateParentScopes = () => (
  <>
    <main>
      <Panel key={workspaceId} />
    </main>
    <aside>
      <Panel key={workspaceId} />
    </aside>
  </>
);
````

## .oxlint-plugins/__tests__/no-duplicate-jsx-sibling-key.test.ts

````ts
import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports repeated static sibling identity",
    source: 'const view = <>\n<Item key="same" />\n<Item key={"same"} />\n</>;',
    lines: [3],
    sourcePath: "source.tsx",
  },
  {
    title: "allows distinct siblings and separate parents",
    source:
      'const view = <><Box><Item key="same" /></Box><Box><Item key="same" /></Box><Item key="other" /></>;',
    lines: [],
    sourcePath: "source.tsx",
  },
  {
    title: "reports repeated dynamic sibling identity",
    source:
      "const view = <Box>\n<Item key={item.id} />\n<Item key={item.id} />\n</Box>;",
    lines: [3],
    sourcePath: "source.tsx",
  },
];

test.each(cases)(
  "no-duplicate-jsx-sibling-key: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (
        await runSingleRule("no-duplicate-jsx-sibling-key", source, {
          sourcePath,
        })
      ).lines,
    ).toEqual(lines);
  },
);
````

## .oxlint-plugins/no-disabled-tooltip-trigger.ts

````ts
// A tooltip wrapped around a disabled `Button` can never open.
//
// `buttonVariants` carries `disabled:pointer-events-none`, and the browser
// suppresses pointer and focus events on a natively disabled control anyway, so
// the trigger receives no hover and no focus: the popup explaining *why* the
// action is unavailable is unreachable exactly when it is needed.
//
// `Button` closes the hole for the tooltip it owns — given `tooltip`,
// `aria-label`, or `title` it switches a disabled button to the ARIA
// accessible-disabled pattern (`aria-disabled`, focusable, activation blocked).
// It cannot see a tooltip a caller wraps around it from the outside, which is
// the pattern this rule flags.
//
// Flagged: a `Tooltip` / `TooltipTrigger` whose `render` target is a `Button`
// carrying `disabled`, including through intermediate triggers
// (`<Tooltip render={<DialogTrigger render={<Button disabled />} />} />`).
//
// Allowed: `<Button tooltip={...} disabled />`, a tooltip around an enabled
// Button, and any tooltip whose render target is not a Button.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import { filenameForContext, isAstNode, jsxName } from "./utils.ts";

const TOOLTIP_ELEMENTS = new Set(["Tooltip", "TooltipRoot", "TooltipTrigger"]);

// Following `render` chains costs nothing and no real trigger stack is deeper.
const MAX_RENDER_DEPTH = 8;

const getOpeningElement = (element: unknown): AstNode | null => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  return isAstNode(element.openingElement) ? element.openingElement : null;
};

const getAttribute = (
  openingElement: unknown,
  name: string,
): AstNode | null => {
  if (!isAstNode(openingElement) || !Array.isArray(openingElement.attributes)) {
    return null;
  }
  return (
    openingElement.attributes.find(
      (attribute): attribute is AstNode =>
        isAstNode(attribute) &&
        attribute.type === "JSXAttribute" &&
        jsxName(attribute.name) === name,
    ) ?? null
  );
};

// The JSX element passed as `render={<X />}`, if the value is a literal element.
const getRenderElement = (openingElement: unknown): AstNode | null => {
  const value = getAttribute(openingElement, "render")?.value;
  if (!isAstNode(value)) {
    return null;
  }
  const expression =
    value.type === "JSXExpressionContainer" ? value.expression : value;
  return isAstNode(expression) && expression.type === "JSXElement"
    ? expression
    : null;
};

// Whether this tooltip ends up triggering a `<Button disabled>`.
const triggersDisabledButton = (tooltipElement: unknown): boolean => {
  let element = getRenderElement(getOpeningElement(tooltipElement));
  for (
    let depth = 0;
    element !== null && depth < MAX_RENDER_DEPTH;
    depth += 1
  ) {
    const openingElement = getOpeningElement(element);
    if (
      jsxName(openingElement?.name) === "Button" &&
      getAttribute(openingElement, "disabled") !== null
    ) {
      return true;
    }
    element = getRenderElement(openingElement);
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "no-disabled-tooltip-trigger" },
  rules: {
    "no-disabled-tooltip-trigger": {
      meta: {
        type: "problem",
        messages: {
          unreachableTooltip:
            "A disabled Button receives no hover or focus, so this tooltip can never open. Pass the content to the Button's own `tooltip` prop, which keeps the button reachable while blocking activation.",
        },
      },
      createOnce(context) {
        return {
          before() {
            return filenameForContext(context).endsWith(".tsx");
          },
          JSXElement(node) {
            const name = jsxName(getOpeningElement(node)?.name);
            if (
              name === null ||
              !TOOLTIP_ELEMENTS.has(name) ||
              !triggersDisabledButton(node)
            ) {
              return;
            }

            context.report({ node, messageId: "unreachableTooltip" });
          },
        };
      },
    },
  },
});
````

## .oxlint-plugins/__fixtures__/no-disabled-tooltip-trigger.fixture.tsx

````ts
// Passive regression fixture for
// `no-disabled-tooltip-trigger/no-disabled-tooltip-trigger`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { Button } from "@stll/ui/button";
import { DialogTrigger } from "@stll/ui/dialog";
import { MenuTrigger } from "@stll/ui/menu";
import { TooltipTrigger } from "@stll/ui/tooltip";

import Tooltip from "@/components/tooltip";

const t = (key: string) => key;
const isBusy = false;

// --- Flagged: a disabled Button as the tooltip's render target ---
export const _a = () => (
  // oxlint-disable-next-line no-disabled-tooltip-trigger/no-disabled-tooltip-trigger
  <Tooltip content={t("save")} render={<Button disabled />} />
);
export const _b = () => (
  // oxlint-disable-next-line no-disabled-tooltip-trigger/no-disabled-tooltip-trigger
  <Tooltip content={t("save")} render={<Button disabled={isBusy} />} />
);
// Flagged through an intermediate trigger.
export const _c = () => (
  // oxlint-disable-next-line no-disabled-tooltip-trigger/no-disabled-tooltip-trigger
  <Tooltip
    content={t("save")}
    render={<DialogTrigger render={<Button disabled={isBusy} />} />}
  />
);
// Flagged on the Base UI trigger part too.
export const _d = () => (
  // oxlint-disable-next-line no-disabled-tooltip-trigger/no-disabled-tooltip-trigger
  <TooltipTrigger render={<Button disabled={isBusy} />} />
);
// Flagged: the Button's own `tooltip` prop does not excuse a second, outer one.
export const _e = () => (
  // oxlint-disable-next-line no-disabled-tooltip-trigger/no-disabled-tooltip-trigger
  <Tooltip
    content={t("save")}
    render={<Button disabled tooltip={t("save")} />}
  />
);

// --- Allowed: the Button owns its tooltip, so it stays reachable ---
export const _ok1 = () => <Button disabled tooltip={t("save")} />;
export const _ok2 = () => <Button disabled={isBusy} tooltip={t("save")} />;
// Allowed: an enabled Button can be hovered, so an outer tooltip works.
// expect-clean: no-disabled-tooltip-trigger/no-disabled-tooltip-trigger
export const _ok3 = () => <Tooltip content={t("save")} render={<Button />} />;
// Allowed: the render target is not a Button.
export const _ok4 = () => (
  <Tooltip content={t("save")} render={<MenuTrigger disabled={isBusy} />} />
);
// Allowed: a Base UI trigger part around an enabled Button.
export const _ok5 = () => <TooltipTrigger render={<Button />} />;
````

## .oxlint-plugins/__tests__/no-disabled-tooltip-trigger.test.ts

````ts
import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports unreachable external tooltip",
    source: "const view = <Tooltip render={<Button disabled />} />;",
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "reports disabled button through render chain",
    source:
      "const view = <TooltipTrigger render={<DialogTrigger render={<Button disabled />} />} />;",
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "allows owned tooltip and enabled controls",
    source:
      'const view = <><Button disabled tooltip="Reason" /><Tooltip render={<Button />} /><Tooltip render={<span />} /></>;',
    lines: [],
    sourcePath: "source.tsx",
  },
];

test.each(cases)(
  "no-disabled-tooltip-trigger: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (
        await runSingleRule("no-disabled-tooltip-trigger", source, {
          sourcePath,
        })
      ).lines,
    ).toEqual(lines);
  },
);
````

## .oxlint-plugins/no-dialog-trigger-menu-item.ts

````ts
// A dialog trigger mounted inside a menu item forces the menu to stay open
// under the dialog.
//
// `<AlertDialogTrigger render={<MenuItem closeOnClick={false} />}>` (or the
// same shape with `DialogTrigger` / `SheetTrigger` / `PopoverTrigger` around
// `MenuItem` / `MenuSubTrigger` / `ContextMenuItem` / `DropdownMenuItem`)
// needs `closeOnClick={false}` precisely because closing the menu would
// unmount the trigger, and the dialog with it. The fix is to lift the dialog
// beside the menu with its own `open` state and have the item request it
// (see `apps/web/src/routes/_protected.workspaces/$workspaceId/-components/row-actions.tsx`
// and `apps/web/src/components/pdf/versions-sidebar.tsx`).
//
// Flags the menu-item element both as the trigger's `render` target and as a
// direct JSX child of the trigger.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import { isAstNode } from "./utils.ts";

const TRIGGER_NAMES = new Set([
  "AlertDialogTrigger",
  "DialogTrigger",
  "SheetTrigger",
  "PopoverTrigger",
]);

const MENU_ITEM_NAMES = new Set([
  "MenuItem",
  "MenuSubTrigger",
  "ContextMenuItem",
  "DropdownMenuItem",
]);

const jsxElementName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXIdentifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "JSXMemberExpression") {
    return jsxElementName(node.property);
  }
  if (node.type === "JSXNamespacedName") {
    return jsxElementName(node.name);
  }
  return null;
};

const getOpeningElement = (element: unknown): AstNode | null => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  return isAstNode(element.openingElement) ? element.openingElement : null;
};

const nameOfJsxElement = (element: unknown): string | null =>
  jsxElementName(getOpeningElement(element)?.name);

const getAttribute = (
  openingElement: unknown,
  name: string,
): AstNode | null => {
  if (!isAstNode(openingElement) || !Array.isArray(openingElement.attributes)) {
    return null;
  }
  return (
    openingElement.attributes.find(
      (attribute): attribute is AstNode =>
        isAstNode(attribute) &&
        attribute.type === "JSXAttribute" &&
        jsxElementName(attribute.name) === name,
    ) ?? null
  );
};

// The JSX element passed as `render={<X />}`, if the value is a literal element.
const getRenderTarget = (openingElement: unknown): AstNode | null => {
  const value = getAttribute(openingElement, "render")?.value;
  if (!isAstNode(value)) {
    return null;
  }
  const expression =
    value.type === "JSXExpressionContainer" ? value.expression : value;
  return isAstNode(expression) && expression.type === "JSXElement"
    ? expression
    : null;
};

// The trigger's direct JSX-element children (text and expression children
// are not menu items, so they are skipped).
const getChildElements = (element: unknown): AstNode[] => {
  if (!isAstNode(element) || !Array.isArray(element.children)) {
    return [];
  }
  return element.children.filter(
    (child): child is AstNode =>
      isAstNode(child) && child.type === "JSXElement",
  );
};

// Whether this trigger mounts a menu item as its `render` target or as a
// direct child.
const mountsMenuItem = (triggerElement: unknown): boolean => {
  const openingElement = getOpeningElement(triggerElement);
  const renderName = nameOfJsxElement(getRenderTarget(openingElement));
  if (renderName !== null && MENU_ITEM_NAMES.has(renderName)) {
    return true;
  }
  return getChildElements(triggerElement).some((child) => {
    const childName = nameOfJsxElement(child);
    return childName !== null && MENU_ITEM_NAMES.has(childName);
  });
};

export default eslintCompatPlugin({
  meta: { name: "no-dialog-trigger-menu-item" },
  rules: {
    "no-dialog-trigger-menu-item": {
      meta: {
        type: "problem",
        messages: {
          triggerInsideMenuItem:
            "Do not mount a dialog trigger inside a menu item; the menu cannot close under the dialog. Lift the dialog beside the menu with `open` state and let the item request it.",
        },
      },
      createOnce(context) {
        return {
          JSXElement(node) {
            const triggerName = nameOfJsxElement(node);
            if (
              triggerName === null ||
              !TRIGGER_NAMES.has(triggerName) ||
              !mountsMenuItem(node)
            ) {
              return;
            }

            context.report({ node, messageId: "triggerInsideMenuItem" });
          },
        };
      },
    },
  },
});
````

## .oxlint-plugins/__fixtures__/no-dialog-trigger-menu-item.fixture.tsx

````ts
// Passive regression fixture for
// `no-dialog-trigger-menu-item/no-dialog-trigger-menu-item`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { AlertDialog, AlertDialogTrigger } from "@stll/ui/alert-dialog";
import { ContextMenuItem } from "@stll/ui/context-menu";
import { DialogTrigger } from "@stll/ui/dialog";
import { DropdownMenuItem } from "@stll/ui/dropdown-menu";
import { Menu, MenuItem, MenuSubTrigger } from "@stll/ui/menu";
import { PopoverTrigger } from "@stll/ui/popover";
import { SheetTrigger } from "@stll/ui/sheet";

const t = (key: string) => key;
const noop = () => undefined;
const open = false;

// --- Flagged: menu item as the trigger's `render` target ---
export const _a = () => (
  // oxlint-disable-next-line no-dialog-trigger-menu-item/no-dialog-trigger-menu-item
  <AlertDialogTrigger
    render={<MenuItem closeOnClick={false} variant="destructive" />}
  >
    {t("common.delete")}
  </AlertDialogTrigger>
);
export const _b = () => (
  // oxlint-disable-next-line no-dialog-trigger-menu-item/no-dialog-trigger-menu-item
  <DialogTrigger render={<MenuItem closeOnClick={false} />}>
    {t("common.rename")}
  </DialogTrigger>
);
export const _c = () => (
  // oxlint-disable-next-line no-dialog-trigger-menu-item/no-dialog-trigger-menu-item
  <SheetTrigger render={<ContextMenuItem closeOnClick={false} />}>
    {t("common.share")}
  </SheetTrigger>
);
export const _d = () => (
  // oxlint-disable-next-line no-dialog-trigger-menu-item/no-dialog-trigger-menu-item
  <PopoverTrigger render={<DropdownMenuItem closeOnClick={false} />}>
    {t("common.export")}
  </PopoverTrigger>
);
export const _e = () => (
  // oxlint-disable-next-line no-dialog-trigger-menu-item/no-dialog-trigger-menu-item
  <AlertDialogTrigger render={<MenuSubTrigger closeOnClick={false} />}>
    {t("common.more")}
  </AlertDialogTrigger>
);

// --- Flagged: menu item as a direct child instead of `render` ---
export const _f = () => (
  // oxlint-disable-next-line no-dialog-trigger-menu-item/no-dialog-trigger-menu-item
  <DialogTrigger>
    <MenuItem closeOnClick={false}>{t("common.rename")}</MenuItem>
  </DialogTrigger>
);

// --- Allowed: the dialog is lifted beside the menu with `open` state ---
export const _ok1 = () => (
  <>
    <Menu>
      <MenuItem onClick={noop} variant="destructive">
        {t("common.delete")}
      </MenuItem>
    </Menu>
    <AlertDialog onOpenChange={noop} open={open} />
  </>
);
// Allowed: a trigger whose render target is not a menu item.
export const _ok2 = () => (
  // expect-clean: no-dialog-trigger-menu-item/no-dialog-trigger-menu-item
  <DialogTrigger render={<button type="button">{t("common.edit")}</button>} />
);
// Allowed: a menu item with no dialog trigger around it.
export const _ok3 = () => <MenuItem>{t("common.duplicate")}</MenuItem>;
// Allowed: an enabled Popover trigger around an ordinary button, not a menu item.
export const _ok4 = () => <PopoverTrigger render={<button type="button" />} />;
````

## .oxlint-plugins/__tests__/no-dialog-trigger-menu-item.test.ts

````ts
import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects menu items mounted as dialog render targets", async () => {
  expect(
    await lintSingleRule(
      "no-dialog-trigger-menu-item",
      "const view = <AlertDialogTrigger render={<MenuItem closeOnClick={false} />} />;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1]);
});

test("rejects direct menu item children of triggers", async () => {
  expect(
    await lintSingleRule(
      "no-dialog-trigger-menu-item",
      "const view = <SheetTrigger><DropdownMenuItem /></SheetTrigger>;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1]);
});

test("rejects compound trigger and menu item names", async () => {
  expect(
    await lintSingleRule(
      "no-dialog-trigger-menu-item",
      "const view = <UI.DialogTrigger render={<UI.ContextMenuItem />} />;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1]);
});

test("accepts a dialog lifted beside the menu", async () => {
  expect(
    await lintSingleRule(
      "no-dialog-trigger-menu-item",
      "const view = <><MenuItem onClick={() => setOpen(true)} /><Dialog open={open} /></>;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("accepts ordinary buttons as trigger targets", async () => {
  expect(
    await lintSingleRule(
      "no-dialog-trigger-menu-item",
      "const view = <PopoverTrigger render={<Button />} />;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});
````

## .oxlint-plugins/utils.ts

````ts
// Shared AST helpers for the rules in this folder.
//
// Oxlint plugin AST nodes are passed in untyped. Each helper narrows from
// `unknown` so rule files can call them without per-call type ceremony or
// shared type-import boilerplate.

import type { ESTree, Ranged, Scope, Variable } from "@oxlint/plugins";

import { isDatabaseHandleName, MUTATION_METHODS } from "./database-access.ts";
import { canonicalModuleId } from "./module-id.ts";

export { canonicalModuleId, exactModuleId } from "./module-id.ts";

type NodeFieldNames<Node> = Node extends unknown ? keyof Node : never;

// Nodes are untrusted at this boundary: declared ESTree fields remain
// unknown until each helper validates them, without an independent field list.
export type AstNode = Ranged & { type: string } & Partial<
    Record<NodeFieldNames<ESTree.Node>, unknown>
  > &
  Record<string, unknown>;

export type FilenameContext = {
  filename?: string;
  getFilename?: () => string;
};

export const filenameForContext = (context: FilenameContext): string =>
  (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");

export const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string" &&
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
// The static text of a string literal or a zero-expression template literal:
// `` `jsonb` `` and `"jsonb"` spell the same value, so a backtick literal
// matches too.
export const staticStringValue = (node: unknown): string | null => {
  if (isStringLiteral(node)) {
    return node.value;
  }
  if (!isAstNode(node) || node.type !== "TemplateLiteral") {
    return null;
  }
  const expressions = node.expressions;
  const quasis = node.quasis;
  if (!Array.isArray(expressions) || expressions.length !== 0) {
    return null;
  }
  if (!Array.isArray(quasis) || quasis.length !== 1) {
    return null;
  }
  const quasi = quasis[0];
  if (!isAstNode(quasi)) {
    return null;
  }
  const value = quasi.value;
  if (typeof value !== "object" || value === null || !("cooked" in value)) {
    return null;
  }
  return typeof value.cooked === "string" ? value.cooked : null;
};

export const getPropertyName = (node: unknown): string | null => {
  if (isIdentifier(node)) {
    return node.name;
  }
  if (isStringLiteral(node)) {
    return node.value;
  }
  return null;
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

// Nodes that wrap an expression without changing its runtime value:
// `x as T`, `x satisfies T`, `<T>x`, `x!`, `f<T>`, `(x)`, and the optional
// chain container around `a?.b`.
export const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

// Peel value-preserving wrappers so a shape check sees the underlying
// expression. Returns the original node when no wrapping is present.
export const unwrapExpression = (node: unknown): AstNode | null => {
  let current = node;
  while (isAstNode(current) && TRANSPARENT_WRAPPERS.has(current.type)) {
    current = current.expression;
  }
  return isAstNode(current) ? current : null;
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

// --- Loop and async-boundary shape, shared by the await-in-loop rules -------
//
// `no-network-await-in-loop` and the type-aware `scripts/db-await-in-loop.ts`
// must agree on what counts as per-iteration work; the script mirrors these
// positions on the TypeScript AST.

// Positions of a loop node that re-run on every iteration. A `for`
// initializer and a `for-of` / `for-in` right-hand side are evaluated once, so
// an await there costs one round-trip, not one per item.
// Keyed by node type, so a lookup for any other node type misses: the value
// is optional, not a total map over a closed union.
const PER_ITERATION_LOOP_FIELDS: Record<string, readonly string[] | undefined> =
  {
    ForStatement: ["body", "test", "update"],
    ForOfStatement: ["body"],
    ForInStatement: ["body"],
    WhileStatement: ["body", "test"],
    DoWhileStatement: ["body", "test"],
  };

export const LOOP_NODE_TYPES: ReadonlySet<string> = new Set(
  Object.keys(PER_ITERATION_LOOP_FIELDS),
);

export const isPerIterationLoopPosition = (
  loop: unknown,
  child: unknown,
): boolean => {
  if (!isAstNode(loop)) {
    return false;
  }
  const fields = PER_ITERATION_LOOP_FIELDS[loop.type];
  return fields?.some((field) => loop[field] === child) ?? false;
};

const FUNCTION_NODE_TYPES: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

// The statement a `break` or `continue` leaves: its labelled statement, or
// else the nearest loop (or `switch`, for an unlabelled `break`). `null` for
// any other node, and when the jump would have to cross a function boundary.
export const abruptCompletionTarget = (node: AstNode): AstNode | null => {
  if (node.type !== "BreakStatement" && node.type !== "ContinueStatement") {
    return null;
  }
  const labelName = isIdentifier(node.label) ? node.label.name : null;
  let current = isAstNode(node.parent) ? node.parent : null;
  while (current !== null) {
    if (
      labelName !== null &&
      current.type === "LabeledStatement" &&
      isIdentifier(current.label, labelName)
    ) {
      return current;
    }
    if (
      labelName === null &&
      (LOOP_NODE_TYPES.has(current.type) ||
        (node.type === "BreakStatement" && current.type === "SwitchStatement"))
    ) {
      return current;
    }
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      return null;
    }
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return null;
};

const collectReturnArguments = (node: unknown, results: AstNode[]): void => {
  if (!isAstNode(node)) {
    return;
  }
  switch (node.type) {
    case "BlockStatement": {
      if (Array.isArray(node.body)) {
        for (const statement of node.body) {
          collectReturnArguments(statement, results);
        }
      }
      return;
    }
    case "IfStatement": {
      collectReturnArguments(node.consequent, results);
      collectReturnArguments(node.alternate, results);
      return;
    }
    case "SwitchStatement": {
      if (Array.isArray(node.cases)) {
        for (const switchCase of node.cases) {
          if (isAstNode(switchCase) && Array.isArray(switchCase.consequent)) {
            for (const statement of switchCase.consequent) {
              collectReturnArguments(statement, results);
            }
          }
        }
      }
      return;
    }
    case "TryStatement": {
      collectReturnArguments(node.block, results);
      if (isAstNode(node.handler)) {
        collectReturnArguments(node.handler.body, results);
      }
      collectReturnArguments(node.finalizer, results);
      return;
    }
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "LabeledStatement": {
      collectReturnArguments(node.body, results);
      return;
    }
    case "ReturnStatement": {
      if (isAstNode(node.argument)) {
        results.push(node.argument);
      }
      return;
    }
    default:
      return;
  }
};

// The `argument` of every `return` reachable from `node` without crossing into
// a nested function's body: a `return` inside a callback the function passes
// on is not a return of the function itself.
export const returnArguments = (node: unknown): AstNode[] => {
  const results: AstNode[] = [];
  collectReturnArguments(node, results);
  return results;
};

const isResultTryPromiseArgument = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const call = node.parent;
  if (
    !isAstNode(call) ||
    call.type !== "CallExpression" ||
    !isMemberAccess(call.callee, "Result", "tryPromise")
  ) {
    return false;
  }
  return Array.isArray(call.arguments) && call.arguments.includes(node);
};

// `Result.tryPromise(async () => ...)` and its object form
// `Result.tryPromise({ try: async () => ..., catch })` run the callback where
// it stands. Inside a loop that callback is the loop's own work, so a walk
// looking for the enclosing loop passes through this boundary instead of
// stopping at it.
export const isResultTryPromiseCallback = (fnNode: unknown): boolean => {
  if (!isAstNode(fnNode)) {
    return false;
  }
  const parent = fnNode.parent;
  if (
    isAstNode(parent) &&
    parent.type === "Property" &&
    parent.value === fnNode &&
    getPropertyName(parent.key) === "try"
  ) {
    const objectExpression = parent.parent;
    return (
      isAstNode(objectExpression) &&
      objectExpression.type === "ObjectExpression" &&
      isResultTryPromiseArgument(objectExpression)
    );
  }
  return isResultTryPromiseArgument(fnNode);
};

// Leftmost identifier of a member/call chain, descending through
// `CallExpression.callee` and `MemberExpression.object`. Computed access is
// traversed too: a generated route reads `api["copy-to-workspace"].post()`,
// and its root is still the imported client.
export const resolveChainRootName = (node: unknown): string | null => {
  const current = unwrapExpression(node);
  if (!isAstNode(current)) {
    return null;
  }
  if (current.type === "CallExpression") {
    return resolveChainRootName(current.callee);
  }
  if (current.type === "MemberExpression") {
    return resolveChainRootName(current.object);
  }
  return isIdentifier(current) ? current.name : null;
};

// --- Tailwind class strings, shared by the rules that read them -------------
//
// A class string reaches a rule as a `Literal` or a `TemplateElement`, with no
// guarantee it holds only classes: `cn()` arguments, `cva` variant maps, and
// interpolated templates all arrive here. Splitting on whitespace and the
// punctuation that separates expressions keeps the tokens usable across all
// three, and the split deliberately leaves `[` and `]` alone so an arbitrary
// variant stays one token.

const CLASS_TOKEN_SPLIT = /[\s"'`{}()]+/u;

export const classTokens = (value: string): string[] =>
  value.split(CLASS_TOKEN_SPLIT).filter(Boolean);

/**
 * The utility a token applies, with its Tailwind variant prefixes dropped
 * (`sm:`, `hover:`, `group-data-[x=true]/rail:`, `[&_pre]:`). The last colon
 * is the boundary: a colon inside an arbitrary value (`supports-[overflow:
 * clip]:`) is still followed by one.
 */
export const classBaseName = (token: string): string => {
  const boundary = token.lastIndexOf(":");
  return boundary === -1 ? token : token.slice(boundary + 1);
};

/** The variant prefixes of a token, or "" when it carries none. */
export const classVariants = (token: string): string => {
  const boundary = token.lastIndexOf(":");
  return boundary === -1 ? "" : token.slice(0, boundary);
};

// --- JSX shape, shared by the rules that read markup ------------------------

// The name a JSX element is written under, descending through the member and
// namespaced forms: `Dialog.Footer` names `Footer`, `svg:path` names `path`.
export const jsxName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXIdentifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "JSXMemberExpression") {
    return jsxName(node.property);
  }
  if (node.type === "JSXNamespacedName") {
    return jsxName(node.name);
  }
  return null;
};

// The name a JSXElement renders, or null for anything that is not one.
export const elementName = (element: unknown): string | null => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  return isAstNode(element.openingElement)
    ? jsxName(element.openingElement.name)
    : null;
};

// Every node under `root`, reached without assuming a shape: asking what a
// component renders means crossing statements, branches, and helper calls that
// a JSX-only traversal never sees.
export const everyNode = (root: unknown): AstNode[] => {
  const out: AstNode[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isAstNode(current) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    out.push(current);
    for (const [key, value] of Object.entries(current)) {
      // `parent` walks back out of the subtree under inspection.
      if (key !== "parent" && typeof value === "object") {
        pending.push(value);
      }
    }
  }
  return out;
};

// --- Files -------------------------------------------------------------------

// The linted file as a repository-relative, forward-slash path. Oxlint runs
// from the repository root, so the working directory anchors the relative
// form; a path outside it stays absolute.
export const repoRelativeFilename = (context: FilenameContext): string => {
  const filename = filenameForContext(context);
  const root = `${process.cwd().replaceAll("\\", "/")}/`;
  return filename.startsWith(root) ? filename.slice(root.length) : filename;
};

// Whether the linted file is one of `files`, each a repository-relative path
// or path suffix (`lib/s3.ts` names every file ending in it).
export const isFileIn = (
  context: FilenameContext,
  files: readonly string[],
): boolean => {
  const filename = filenameForContext(context);
  return files.some((file) => filename.endsWith(file));
};

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const TEST_DIRECTORY_PATTERN = /(?:^|\/)(?:tests?|__tests__)\//u;

// Test sources: `*.test.*` / `*.spec.*` files and anything under a `test/`,
// `tests/` or `__tests__/` directory.
export const isTestFile = (filename: string): boolean =>
  TEST_FILE_PATTERN.test(filename) || TEST_DIRECTORY_PATTERN.test(filename);

// --- Identifiers and scope ---------------------------------------------------

// An Identifier the parser emitted as a value reference (it carries a range,
// which synthetic name nodes do not).
export const isIdentifierReference = (
  node: unknown,
): node is ESTree.IdentifierReference =>
  isIdentifier(node) && Array.isArray(node.range);

export type ScopeContext = {
  sourceCode: { getScope: (node: ESTree.Node) => Scope };
};

// The variable an identifier binds to, found by walking the scope chain from
// the identifier outwards. Null for an unresolved (global) name.
export const resolveVariable = (
  context: ScopeContext,
  identifier: ESTree.IdentifierReference | ESTree.JSXIdentifier,
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

// Whether a variable is never reassigned after its declaration, so its
// initializer is the only value it can hold.
export const isSingleAssignment = (variable: Variable): boolean =>
  variable.references.every(
    (reference) => !reference.isWrite() || reference.init,
  );

// The initializer of a variable declared exactly once and never reassigned.
export const stableInitializer = (variable: Variable): AstNode | null => {
  const definition = variable.defs.at(0);
  if (
    variable.defs.length !== 1 ||
    definition?.type !== "Variable" ||
    !isAstNode(definition.node) ||
    definition.node.type !== "VariableDeclarator" ||
    !isSingleAssignment(variable)
  ) {
    return null;
  }
  return isAstNode(definition.node.init) ? definition.node.init : null;
};

// --- Import resolution ------------------------------------------------------
//
// Rules that guard a helper or a primitive must know what a name is bound to,
// not how it is spelled: `import { x as y }`, `import * as ns` with `ns.x`,
// `const { x } = ns`, `const y = x`, `require("m").x` and `await import("m")`
// all reach the same export. The resolver answers "which export of which
// module is this expression?"; a local, a parameter, or a call result
// answers null.

// `imported` is the export name, "default" for a default import, and "*" for
// the module namespace object itself.
export type ImportedBinding = { source: string; imported: string };

export const NAMESPACE_IMPORT = "*";

const isCreateRequireReference = (
  context: ScopeContext,
  reference: ESTree.IdentifierReference,
): boolean => {
  const variable = resolveVariable(context, reference);
  const initializer = variable === null ? null : stableInitializer(variable);
  const definition = variable?.defs.at(0);
  if (
    variable === null ||
    initializer?.type !== "CallExpression" ||
    !isAstNode(definition?.node) ||
    !isAstNode(definition.parent) ||
    definition.parent.type !== "VariableDeclaration" ||
    definition.parent.kind !== "const" ||
    !isIdentifier(definition.node.id, reference.name)
  ) {
    return false;
  }
  const callee = unwrapExpression(initializer.callee);
  const base =
    callee?.type === "MemberExpression"
      ? unwrapExpression(callee.object)
      : callee;
  if (
    !isIdentifierReference(base) ||
    resolveVariable(context, base)?.defs.at(0)?.type !== "ImportBinding"
  ) {
    return false;
  }
  // Only an imported factory is eligible; a loader cannot prove itself through
  // another call to its own binding.
  const factory = resolveImportedExpressionForEnforcement(context, callee);
  return (
    factory?.imported === "createRequire" &&
    (factory.source === "node:module" || factory.source === "module")
  );
};

// Enforcement provenance recognizes stable loaders regardless of read count.
// Admission checks must separately prove that the expression is eligible.
export const dynamicModuleSourceForEnforcement = (
  node: unknown,
  context: ScopeContext,
): string | null => {
  const expression = unwrapExpression(node);
  if (!isAstNode(expression)) {
    return null;
  }
  if (expression.type === "AwaitExpression") {
    return dynamicModuleSourceForEnforcement(expression.argument, context);
  }
  if (expression.type === "ImportExpression") {
    return isStringLiteral(expression.source) ? expression.source.value : null;
  }
  if (
    expression.type === "CallExpression" &&
    isIdentifierReference(expression.callee) &&
    Array.isArray(expression.arguments) &&
    expression.arguments.length === 1 &&
    isStringLiteral(expression.arguments[0])
  ) {
    const binding = resolveVariable(context, expression.callee);
    const globalRequire =
      expression.callee.name === "require" &&
      (binding === null || binding.defs.length === 0);
    return globalRequire || isCreateRequireReference(context, expression.callee)
      ? expression.arguments[0].value
      : null;
  }
  return null;
};

// The static key of a member expression: `a.b`, `a["b"]`, `` a[`b`] ``.
export const memberPropertyName = (member: AstNode): string | null => {
  if (member.computed !== true) {
    return getPropertyName(member.property);
  }
  if (isStringLiteral(member.property)) {
    return member.property.value;
  }
  const property = member.property;
  if (
    !isAstNode(property) ||
    property.type !== "TemplateLiteral" ||
    !Array.isArray(property.expressions) ||
    property.expressions.length > 0 ||
    !Array.isArray(property.quasis)
  ) {
    return null;
  }
  const quasi: unknown = property.quasis[0];
  if (!isAstNode(quasi)) {
    return null;
  }
  const value: unknown = quasi.value;
  const cooked =
    typeof value === "object" && value !== null
      ? Reflect.get(value, "cooked")
      : undefined;
  return typeof cooked === "string" ? cooked : null;
};

// The export read by `namespace.property` when `base` is a module namespace.
const memberOfNamespace = (
  base: ImportedBinding | null,
  property: string | null,
): ImportedBinding | null =>
  base?.imported === NAMESPACE_IMPORT && property !== null
    ? { source: base.source, imported: property }
    : null;

// The key a destructuring pattern reads for `binding`: `{ x }`, `{ x: y }`,
// `{ x = d }`, `{ "x": y }`.
export const patternKeyFor = (
  pattern: AstNode,
  binding: unknown,
): string | null => {
  if (!Array.isArray(pattern.properties)) {
    return null;
  }
  for (const property of pattern.properties) {
    if (!isAstNode(property) || property.type !== "Property") {
      continue;
    }
    const value = isAstNode(property.value) ? property.value : null;
    const target =
      value?.type === "AssignmentPattern" ? value.left : (value ?? null);
    if (target !== binding) {
      continue;
    }
    if (property.computed === true && !isStringLiteral(property.key)) {
      return null;
    }
    return getPropertyName(property.key);
  }
  return null;
};

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
    !isSingleAssignment(variable)
  ) {
    return null;
  }
  const loaded = dynamicModuleSourceForEnforcement(node.init, context);
  const init =
    loaded === null
      ? resolveImportedExpressionForEnforcement(context, node.init, seen)
      : { source: loaded, imported: NAMESPACE_IMPORT };
  if (init === null) {
    return null;
  }
  if (isIdentifier(node.id)) {
    return init;
  }
  if (isAstNode(node.id) && node.id.type === "ObjectPattern") {
    return memberOfNamespace(init, patternKeyFor(node.id, definition.name));
  }
  return null;
};

// Enforcement provenance; recognizing a binding never grants an exemption.
// The module export an expression evaluates to, or null when it is anything
// else: a local, a parameter, a call result, an unresolved global.
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
    const loaded = dynamicModuleSourceForEnforcement(
      expression.object,
      context,
    );
    const base =
      loaded === null
        ? resolveImportedExpressionForEnforcement(
            context,
            expression.object,
            seen,
          )
        : { source: loaded, imported: NAMESPACE_IMPORT };
    return memberOfNamespace(base, memberPropertyName(expression));
  }
  return null;
};

// A module an import may come from: a bare package specifier or a repository
// path without extension (`apps/api/src/lib/escape-like`), or a predicate over
// the canonical id.
export type ModuleMatcher = string | ((moduleId: string) => boolean);

export const moduleMatches = (
  matcher: ModuleMatcher,
  moduleId: string,
): boolean =>
  typeof matcher === "function" ? matcher(moduleId) : matcher === moduleId;

// The resolved import behind `node` with its module in canonical form.
export type ResolvedImport = { moduleId: string; imported: string };

export const resolveImport = (
  context: ScopeContext & FilenameContext,
  node: unknown,
): ResolvedImport | null => {
  const binding = resolveImportedExpressionForEnforcement(context, node);
  if (binding === null) {
    return null;
  }
  return {
    moduleId: canonicalModuleId(binding.source, repoRelativeFilename(context)),
    imported: binding.imported,
  };
};

// Whether `node` evaluates to one of `names` exported by a module accepted by
// `modules`. Use NAMESPACE_IMPORT as a name to accept the namespace object.
export type ImportedFromOptions = {
  context: ScopeContext & FilenameContext;
  node: unknown;
  modules: readonly ModuleMatcher[];
  names: ReadonlySet<string>;
};

export const isImportedFrom = ({
  context,
  node,
  modules,
  names,
}: ImportedFromOptions): boolean => {
  const resolved = resolveImport(context, node);
  return (
    resolved !== null &&
    names.has(resolved.imported) &&
    modules.some((matcher) => moduleMatches(matcher, resolved.moduleId))
  );
};

// The function a call invokes, seen through the forms that call it
// indirectly: `(0, f)()`, `f.call(...)`, `f.apply(...)`.
export const invokedCallee = (call: AstNode): AstNode | null => {
  const callee = unwrapExpression(call.callee);
  if (!isAstNode(callee)) {
    return null;
  }
  if (
    callee.type === "SequenceExpression" &&
    Array.isArray(callee.expressions)
  ) {
    return unwrapExpression(callee.expressions.at(-1));
  }
  if (callee.type === "MemberExpression") {
    const method = memberPropertyName(callee);
    if (method === "call" || method === "apply") {
      return unwrapExpression(callee.object);
    }
  }
  return callee;
};

// --- Database writes --------------------------------------------------------
//
// A Drizzle row write: `<handle>.insert(...)`, `.update(...)` or `.delete(...)`
// where the receiver is a database handle (`tx` / `db` / `trx`, a camel-cased
// name ending in `Tx` / `Db`, a member with such a name, a `getDb()`-style
// call, or a parameter of a `.transaction(...)` callback or typed as a
// transaction), or `<receiver>.execute(sql`...`)` whose static SQL inserts,
// updates or deletes rows.

type DatabaseWriteContext = ImportedFromOptions["context"];

// Guards the identifier-to-initializer walk against cycles.
const MAX_SQL_RESOLVE_DEPTH = 4;

const GET_DB_CALL = /^get[A-Za-z]*Db$/u;
const TRANSACTION_TYPE = /(?:^|[a-z])(?:Transaction|Tx)$|^(?:Db|DbOrTx)$/u;

// Static SQL that writes rows. Interpolations are joined as a placeholder
// token so `UPDATE ${table} AS t SET` still reads as one statement.
const WRITE_SQL = [
  /\bINSERT\s+INTO\b/iu,
  /\bDELETE\s+FROM\b/iu,
  /\bUPDATE\s+(?:ONLY\s+)?\S+(?:\s+(?:AS\s+)?\w+)?\s+SET\b/iu,
];
const SQL_PLACEHOLDER = " __value__ ";

const DRIZZLE_SQL: ReadonlySet<string> = new Set(["sql"]);

const isDrizzleModule = (moduleId: string): boolean =>
  moduleId === "drizzle-orm" || moduleId.startsWith("drizzle-orm/");

const typeAnnotationName = (identifier: unknown): string | null => {
  if (!isAstNode(identifier) || !isAstNode(identifier.typeAnnotation)) {
    return null;
  }
  const annotation = identifier.typeAnnotation.typeAnnotation;
  if (!isAstNode(annotation) || annotation.type !== "TSTypeReference") {
    return null;
  }
  const typeName = annotation.typeName;
  if (isIdentifier(typeName)) {
    return typeName.name;
  }
  return isAstNode(typeName) && typeName.type === "TSQualifiedName"
    ? getCalleeName(typeName.right)
    : null;
};

// Whether a function is the callback of `<handle>.transaction(...)` or of a
// handle-named runner such as `safeDb(...)`, which passes its callback a handle.
const isTransactionCallback = (fn: unknown): boolean => {
  const call = isAstNode(fn) ? fn.parent : null;
  if (
    !isAstNode(call) ||
    call.type !== "CallExpression" ||
    !Array.isArray(call.arguments) ||
    !call.arguments.includes(fn)
  ) {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  if (isIdentifierReference(callee)) {
    return isDatabaseHandleName(callee.name);
  }
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const property = memberPropertyName(callee);
  return (
    property !== null &&
    (property === "transaction" || isDatabaseHandleName(property))
  );
};

const isTransactionParameter = (variable: Variable): boolean => {
  const definition = variable.defs.at(0);
  if (variable.defs.length !== 1 || definition?.type !== "Parameter") {
    return false;
  }
  const typeName = typeAnnotationName(definition.name);
  return (
    (typeName !== null && TRANSACTION_TYPE.test(typeName)) ||
    isTransactionCallback(definition.node)
  );
};

const isDatabaseHandle = (
  context: DatabaseWriteContext,
  node: unknown,
): boolean => {
  const receiver = unwrapExpression(node);
  if (receiver === null) {
    return false;
  }
  if (isIdentifierReference(receiver)) {
    if (isDatabaseHandleName(receiver.name)) {
      return true;
    }
    const variable = resolveVariable(context, receiver);
    return variable !== null && isTransactionParameter(variable);
  }
  if (receiver.type === "MemberExpression") {
    const property = memberPropertyName(receiver);
    return property !== null && isDatabaseHandleName(property);
  }
  if (receiver.type === "CallExpression") {
    const name = getCalleeName(receiver.callee)?.split(".").at(-1);
    return name !== undefined && GET_DB_CALL.test(name);
  }
  return false;
};

// The static text of a drizzle `sql` template, or of a const holding one.
const writeSqlText = (
  context: DatabaseWriteContext,
  node: unknown,
  depth = 0,
): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null || depth > MAX_SQL_RESOLVE_DEPTH) {
    return null;
  }
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    const init = variable === null ? null : stableInitializer(variable);
    return init === null ? null : writeSqlText(context, init, depth + 1);
  }
  if (
    expression.type !== "TaggedTemplateExpression" ||
    !isImportedFrom({
      context,
      node: expression.tag,
      modules: [isDrizzleModule],
      names: DRIZZLE_SQL,
    }) ||
    !isAstNode(expression.quasi) ||
    !Array.isArray(expression.quasi.quasis)
  ) {
    return null;
  }
  return expression.quasi.quasis
    .map((quasi: unknown) => {
      const value = isAstNode(quasi) ? quasi.value : null;
      return typeof value === "object" &&
        value !== null &&
        "raw" in value &&
        typeof value.raw === "string"
        ? value.raw
        : "";
    })
    .join(SQL_PLACEHOLDER);
};

export const isDatabaseWriteCall = (
  context: DatabaseWriteContext,
  node: unknown,
): boolean => {
  const call = unwrapExpression(node);
  if (call?.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const method = memberPropertyName(callee);
  if (method !== null && MUTATION_METHODS.has(method)) {
    return isDatabaseHandle(context, callee.object);
  }
  if (method !== "execute" || !Array.isArray(call.arguments)) {
    return false;
  }
  const text = writeSqlText(context, call.arguments.at(0));
  return text !== null && WRITE_SQL.some((pattern) => pattern.test(text));
};

// `a`, `a.b`, `a.b.c`: the dotted name of a table reference, or null.
const dottedName = (node: unknown, depth = 0): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null || depth > MAX_SQL_RESOLVE_DEPTH) {
    return null;
  }
  if (isIdentifier(expression)) {
    return expression.name;
  }
  if (expression.type !== "MemberExpression") {
    return null;
  }
  const object = dottedName(expression.object, depth + 1);
  const property = memberPropertyName(expression);
  return object === null || property === null ? null : `${object}.${property}`;
};

const SQL_WRITE_TARGET =
  /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE(?:\s+ONLY)?)\s+([\w."]+)/iu;

/**
 * What a write `isDatabaseWriteCall` accepts touches, as `<verb>:<table>`
 * (`insert:entities`, `update:schema.members`). Raw SQL reads the verb and
 * table from its static text. `?` stands for a table the source does not
 * name statically. Lets a per-owner budget tell one write from another
 * instead of counting them.
 */
export const databaseWriteTarget = (
  context: DatabaseWriteContext,
  node: unknown,
): string => {
  const call = unwrapExpression(node);
  const callee =
    call?.type === "CallExpression" ? unwrapExpression(call.callee) : null;
  const method =
    callee?.type === "MemberExpression" ? memberPropertyName(callee) : null;
  const args =
    call !== null && Array.isArray(call.arguments) ? call.arguments : [];
  if (method !== null && MUTATION_METHODS.has(method)) {
    return `${method}:${dottedName(args.at(0)) ?? "?"}`;
  }
  const text = writeSqlText(context, args.at(0));
  const match = text === null ? null : SQL_WRITE_TARGET.exec(text);
  const verb = match?.at(1)?.split(/\s+/u).at(0)?.toLowerCase();
  const table = match?.at(2)?.replaceAll('"', "");
  const named =
    table === undefined || table === SQL_PLACEHOLDER.trim() ? "?" : table;
  return `${verb ?? "execute"}:${named}`;
};
````
