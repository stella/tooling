// Split only boolean operators outside parentheses and quoted string literals.
const booleanParts = (source: string, operator: "&&" | "||") => {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "'") {
      if (quoted && source[index + 1] === "'") index++;
      else quoted = !quoted;
    }
    if (quoted) continue;
    if (character === "(") depth++;
    if (character === ")") depth--;
    if (depth === 0 && source.slice(index, index + 2) === operator) {
      parts.push(source.slice(start, index));
      start = index + 2;
      index++;
    }
  }
  parts.push(source.slice(start));
  return parts;
};

const withoutOuterParentheses = (source: string): string => {
  if (!source.startsWith("(") || !source.endsWith(")")) return source;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "'") {
      if (quoted && source[index + 1] === "'") index++;
      else quoted = !quoted;
    }
    if (quoted) continue;
    if (character === "(") depth++;
    if (character === ")") depth--;
    if (depth === 0 && index !== source.length - 1) return source;
  }
  return withoutOuterParentheses(source.slice(1, -1).trim());
};

/** Proves a necessary leaf predicate across every disjunction; unknown atoms never authorize it. */
export const conditionRequires = (
  condition: unknown,
  matches: (source: string) => boolean,
): boolean => {
  if (condition === false) return true;
  if (typeof condition !== "string") return false;
  const source = withoutOuterParentheses(
    condition
      .trim()
      .replace(/^\$\{\{([\s\S]*)\}\}$/u, "$1")
      .trim(),
  );
  const alternatives = booleanParts(source, "||");
  if (alternatives.length > 1)
    return alternatives.every((part) => conditionRequires(part, matches));
  const conjuncts = booleanParts(source, "&&");
  if (conjuncts.length > 1)
    return conjuncts.some((part) => conditionRequires(part, matches));
  return source === "false" || matches(source);
};
