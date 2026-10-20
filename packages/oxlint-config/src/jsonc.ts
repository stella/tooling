/** JSONC permits comments and trailing commas, never alterations inside strings. */
export const parseJsonc = (text: string): unknown => {
  let clean = "";
  let quote = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      clean += char;
      if (char === "\\") {
        index++;
        clean += text[index] ?? "";
      } else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') {
      quote = true;
      clean += char;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      clean += "\n";
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      )
        index++;
      if (index >= text.length) throw new Error("Unterminated JSONC comment");
      index++;
      clean += " ";
      continue;
    }
    clean += char;
  }
  let result = "";
  quote = false;
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index];
    if (quote) {
      result += char;
      if (char === "\\") {
        index++;
        result += clean[index] ?? "";
      } else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') quote = true;
    if (char === ",") {
      let next = index + 1;
      while (/\s/.test(clean[next] ?? "") && next < clean.length) next++;
      if (clean[next] === "}" || clean[next] === "]") continue;
    }
    result += char;
  }
  return JSON.parse(result);
};
