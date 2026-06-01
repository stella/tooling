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
  typeof node.type === "string";

const SHADED_PALETTE_COLORS = [
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "taupe",
  "mauve",
  "mist",
  "olive",
] as const;
const COLOR_SHADES = [
  "50",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
  "950",
] as const;
const COLOR_UTILITY_PREFIXES = [
  "accent",
  "bg",
  "border",
  "border-b",
  "border-e",
  "border-l",
  "border-r",
  "border-s",
  "border-t",
  "border-x",
  "border-y",
  "caret",
  "decoration",
  "divide",
  "drop-shadow",
  "fill",
  "from",
  "inset-ring",
  "inset-shadow",
  "marker",
  "outline",
  "placeholder",
  "ring",
  "ring-offset",
  "scrollbar-thumb",
  "scrollbar-track",
  "shadow",
  "stroke",
  "text",
  "text-shadow",
  "to",
  "via",
] as const;
const COLOR_PREFIXES = COLOR_UTILITY_PREFIXES.join("|");
const SHADED_PALETTE_COLOR_PATTERN = SHADED_PALETTE_COLORS.join("|");
const COLOR_SHADE_PATTERN = COLOR_SHADES.join("|");
const CLASS_COLOR_BOUNDARY = "(?:^|:)!?";

const SHADED_PALETTE_PATTERN = new RegExp(
  `${CLASS_COLOR_BOUNDARY}(?:${COLOR_PREFIXES})-(?:${SHADED_PALETTE_COLOR_PATTERN})-(?:${COLOR_SHADE_PATTERN})(?![\\w-])`,
);
// Standalone white/black utilities; permit opacity (bg-white/20) and compounds
// (bg-whitesmoke) so only the bare palette tokens fire.
const BW_PATTERN = new RegExp(
  `${CLASS_COLOR_BOUNDARY}(?:${COLOR_PREFIXES})-(?:white|black)(?![/\\w-])`,
);

const isRawColorClass = (value: string): boolean =>
  SHADED_PALETTE_PATTERN.test(value) || BW_PATTERN.test(value);

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

const IMPORT_EXPORT_SOURCE_PARENT_TYPES = new Set([
  "ExportAllDeclaration",
  "ExportNamedDeclaration",
  "ImportDeclaration",
  "TSExternalModuleReference",
  "TSImportType",
]);

const isImportOrExportSource = (node: AstNode): boolean => {
  const parent = node.parent;
  return (
    isAstNode(parent) && IMPORT_EXPORT_SOURCE_PARENT_TYPES.has(parent.type)
  );
};

const isDynamicImportCall = (node: AstNode): boolean => {
  if (node.type === "ImportExpression") {
    return true;
  }
  if (node.type !== "CallExpression") {
    return false;
  }
  const callee = node["callee"];
  return isAstNode(callee) && callee.type === "Import";
};

const isDynamicImportSource = (node: AstNode): boolean => {
  const parent = node.parent;
  if (!isAstNode(parent)) {
    return false;
  }
  if (isDynamicImportCall(parent)) {
    return true;
  }
  if (parent.type !== "TemplateLiteral") {
    return false;
  }
  const grandparent = parent.parent;
  return isAstNode(grandparent) && isDynamicImportCall(grandparent);
};

const templateElementText = (node: AstNode): string | null => {
  const value = node["value"];
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const cooked = "cooked" in value ? value.cooked : null;
  if (typeof cooked === "string") {
    return cooked;
  }
  const raw = "raw" in value ? value.raw : null;
  return typeof raw === "string" ? raw : null;
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
            if (isImportOrExportSource(node) || isDynamicImportSource(node)) {
              return;
            }
            checkValue(context, node, value);
          },
          TemplateElement(node: AstNode) {
            if (isDynamicImportSource(node)) {
              return;
            }
            const value = templateElementText(node);
            if (value === null) {
              return;
            }
            checkValue(context, node, value);
          },
        };
      },
    },
  },
};
