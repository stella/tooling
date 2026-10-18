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
  left?: unknown;
  local?: unknown;
  meta?: unknown;
  name?: unknown;
  object?: unknown;
  parent?: unknown;
  property?: unknown;
  quasis?: unknown;
  right?: unknown;
  source?: unknown;
  value?: unknown;
};

export const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "type") === "string";

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
  ) => Record<string, (node: Node) => void>,
) =>
  eslintCompatPlugin({
    meta: { name },
    rules: {
      [name]: {
        meta: { type: "problem", messages: { [messageId]: message } },
        create(context) {
          if (!isTestFile(context)) return {};
          return makeVisitors((node) => context.report({ node, messageId }));
        },
      },
    },
  });
