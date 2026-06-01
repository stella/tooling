// Detect hardcoded Tailwind color classes that bypass semantic tokens.
//
// Semantic tokens (bg-background, bg-muted, text-foreground, bg-success/12, …)
// adapt via CSS variables and stay legible across themes. Raw palette colors
// (bg-stone-50, text-gray-900, bg-emerald-100, text-amber-800, bg-white, …)
// either break dark mode (neutrals) or pin a component to a hue that ignores
// the design system. Use the semantic equivalents instead.

type AstNode = { type: string; parent?: unknown } & Record<string, unknown>;

type RuleContext = {
  report: (diagnostic: {
    node: unknown;
    messageId: "rawColor";
    data?: { match: string };
  }) => void;
};

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof (node as { type: unknown }).type === "string";

const GRAY_SCALES = "stone|slate|gray|zinc|neutral";
const SATURATED_SCALES =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const COLOR_PREFIXES =
  "bg|text|border|ring|outline|shadow|from|to|via|fill|stroke|divide";

const GRAY_PATTERN = new RegExp(`(?:${COLOR_PREFIXES})-(?:${GRAY_SCALES})-\\d`);
const SATURATED_PATTERN = new RegExp(
  `(?:${COLOR_PREFIXES})-(?:${SATURATED_SCALES})-\\d`,
);
// Standalone white/black utilities; permit opacity (bg-white/20) and compounds
// (bg-whitesmoke) so only the bare palette tokens fire.
const BW_PATTERN = new RegExp(
  `(?:${COLOR_PREFIXES})-(?:white|black)(?![/\\w-])`,
);

const isRawColorClass = (value: string): boolean =>
  GRAY_PATTERN.test(value) ||
  SATURATED_PATTERN.test(value) ||
  BW_PATTERN.test(value);

const checkValue = (
  context: RuleContext,
  node: unknown,
  value: string,
): void => {
  for (const token of value.split(/\s+/)) {
    if (isRawColorClass(token)) {
      context.report({
        node,
        messageId: "rawColor",
        data: { match: token },
      });
    }
  }
};

export default {
  meta: { name: "no-raw-colors" },
  rules: {
    "no-raw-colors": {
      meta: {
        type: "problem",
        messages: {
          rawColor:
            "Hardcoded color '{{match}}' bypasses semantic tokens. Use semantic tokens (bg-muted, text-foreground, bg-success/12, bg-warning/12, bg-destructive/12, etc.) instead.",
        },
      },
      create(context: RuleContext) {
        return {
          Literal(node: AstNode) {
            const value = node["value"];
            if (typeof value !== "string") {
              return;
            }
            checkValue(context, node, value);
          },
          TemplateElement(node: AstNode) {
            const raw = node["value"];
            if (!isAstNode(raw) && (typeof raw !== "object" || raw === null)) {
              return;
            }
            const rawText = (raw as { raw?: unknown }).raw;
            if (typeof rawText !== "string") {
              return;
            }
            checkValue(context, node, rawText);
          },
        };
      },
    },
  },
};
