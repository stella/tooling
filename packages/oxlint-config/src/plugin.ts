// Enforce the lowercase "stella" wordmark in source text.
//
// The stella brand identity is a lowercase wordmark. Generated copy and
// hand-written prose can introduce a capitalized form mid-sentence, which
// contradicts the wordmark. This rule scans string literals, template
// literals, and JSX text for capitalized wordmark tokens that are not at a
// sentence boundary and do not look like code identifiers or asset filenames.

type AstNode = { type: string; parent?: unknown } & Record<string, unknown>;

type RuleContext = {
  report: (diagnostic: {
    node: unknown;
    messageId: "lowercaseStella";
    data?: { match: string };
  }) => void;
};

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof (node as { type: unknown }).type === "string";

const isStringLiteral = (node: unknown): node is AstNode & { value: string } =>
  isAstNode(node) &&
  node.type === "Literal" &&
  typeof node["value"] === "string";

const CAPITALIZED_WORDMARK_PATTERN = /\bStella\b/gu;
const WHOLE_PATH = /^(?=.*[/\\.:~@])[\w./\\:~@-]+$/u;
const SKIP_WHITESPACE = new Set([" ", "\t", " "]);
const SKIP_OPENERS = new Set([
  '"',
  "'",
  "`",
  "(",
  "[",
  "{",
  "“",
  "”",
  "‘",
  "’",
  "„",
  "«",
  "»",
  "‹",
  "›",
  "¿",
  "¡",
]);
const SENTENCE_TERMINATORS = new Set([".", "!", "?", "…", "\n", "\r"]);

const isSentenceStart = (
  text: string,
  idx: number,
  isContinuation: boolean,
): boolean => {
  let i = idx - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === undefined) {
      return !isContinuation;
    }
    if (SKIP_WHITESPACE.has(ch) || SKIP_OPENERS.has(ch)) {
      i--;
      continue;
    }
    if (isContinuation && (ch === "\n" || ch === "\r")) {
      i--;
      continue;
    }
    break;
  }
  if (i < 0) {
    return !isContinuation;
  }
  const previous = text[i];
  return previous !== undefined && SENTENCE_TERMINATORS.has(previous);
};

const isCodeLikeSuffix = (text: string, endIdx: number): boolean => {
  const next = text[endIdx];
  if (next === "-" || next === "_") {
    return true;
  }
  if (next === ".") {
    return /[a-z]/u.test(text[endIdx + 1] ?? "");
  }
  return false;
};

const checkText = (
  context: RuleContext,
  node: unknown,
  value: string,
  isContinuation: boolean,
): void => {
  if (!value.includes("Stella")) {
    return;
  }
  if (WHOLE_PATH.test(value)) {
    return;
  }
  CAPITALIZED_WORDMARK_PATTERN.lastIndex = 0;
  let match = CAPITALIZED_WORDMARK_PATTERN.exec(value);
  while (match !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (
      !isSentenceStart(value, start, isContinuation) &&
      !isCodeLikeSuffix(value, end)
    ) {
      context.report({
        node,
        messageId: "lowercaseStella",
        data: { match: match[0] },
      });
      return;
    }
    match = CAPITALIZED_WORDMARK_PATTERN.exec(value);
  }
};

const isImportOrExportSource = (literalNode: AstNode): boolean => {
  const parent = literalNode.parent;
  if (!isAstNode(parent)) {
    return false;
  }
  return (
    parent.type === "ImportDeclaration" ||
    parent.type === "ExportNamedDeclaration" ||
    parent.type === "ExportAllDeclaration"
  );
};

const isJsxContinuation = (node: AstNode): boolean => {
  const parent = node.parent;
  if (!isAstNode(parent)) {
    return false;
  }
  if (parent.type !== "JSXElement" && parent.type !== "JSXFragment") {
    return false;
  }
  const children = parent["children"];
  if (!Array.isArray(children)) {
    return false;
  }
  return children.indexOf(node) > 0;
};

const isJsxExpressionContinuation = (node: AstNode): boolean => {
  const parent = node.parent;
  if (!isAstNode(parent) || parent.type !== "JSXExpressionContainer") {
    return false;
  }
  const grandparent = parent.parent;
  if (!isAstNode(grandparent)) {
    return false;
  }
  if (grandparent.type !== "JSXElement" && grandparent.type !== "JSXFragment") {
    return false;
  }
  const children = grandparent["children"];
  if (!Array.isArray(children)) {
    return false;
  }
  return children.indexOf(parent) > 0;
};

const quasiText = (quasi: unknown): string | null => {
  if (!isAstNode(quasi)) {
    return null;
  }
  const raw = quasi["value"];
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const cooked = (raw as { cooked?: unknown }).cooked;
  if (typeof cooked === "string") {
    return cooked;
  }
  const rawValue = (raw as { raw?: unknown }).raw;
  return typeof rawValue === "string" ? rawValue : null;
};

export default {
  meta: { name: "stella-lowercase" },
  rules: {
    "stella-lowercase": {
      meta: {
        type: "problem",
        messages: {
          lowercaseStella:
            "Use lowercase `stella` for the product wordmark. The capitalized form is only valid at a sentence start.",
        },
      },
      create(context: RuleContext) {
        return {
          Literal(node: AstNode) {
            if (!isStringLiteral(node)) {
              return;
            }
            if (isImportOrExportSource(node)) {
              return;
            }
            checkText(
              context,
              node,
              node.value,
              isJsxExpressionContinuation(node),
            );
          },
          TemplateLiteral(node: AstNode) {
            const quasis = node["quasis"];
            if (!Array.isArray(quasis)) {
              return;
            }
            const headIsContinuation = isJsxExpressionContinuation(node);
            for (let i = 0; i < quasis.length; i++) {
              const quasi = quasis[i];
              const value = quasiText(quasi);
              if (value === null) {
                continue;
              }
              checkText(context, quasi, value, headIsContinuation || i > 0);
            }
          },
          JSXText(node: AstNode) {
            const value = node["value"];
            if (typeof value !== "string") {
              return;
            }
            checkText(context, node, value, isJsxContinuation(node));
          },
        };
      },
    },
  },
};
