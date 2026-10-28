import { parse } from "acorn";
import { transformSync } from "esbuild";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** Read only explicitly declared, tracked regular source files in the checkout. */
type SourceApiInputOptions = {
  root: string;
  source: string;
  tracked: ReadonlySet<string>;
};
export const readSourceApiInput = ({
  root,
  source,
  tracked,
}: SourceApiInputOptions) => {
  if (!tracked.has(source)) return undefined;
  const resolvedRoot = realpathSync(root);
  const input = path.resolve(resolvedRoot, source);
  try {
    if (realpathSync(input) !== input || !lstatSync(input).isFile())
      return undefined;
    return readFileSync(input, "utf8");
  } catch {
    return undefined;
  }
};

/** Syntax evidence binds a declaration to a real value import, never comments or type imports. */
type SourceApiImportOptions = {
  source: string;
  content: string | undefined;
  name: string;
};
export const sourceApiImportProblem = ({
  source,
  content,
  name,
}: SourceApiImportOptions) => {
  if (content === undefined)
    return "must be a tracked, readable regular source file without symlinks";
  try {
    const { code } = transformSync(content, {
      sourcefile: source,
      loader: source.endsWith("x") ? "tsx" : "ts",
      format: "esm",
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
      logLevel: "silent",
    });
    const program = parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
    });
    if (
      program.body.some(
        (node) =>
          node.type === "ImportDeclaration" &&
          node.source.value === name &&
          node.specifiers.length > 0,
      )
    )
      return undefined;
    return `no longer has a static value import from ${name}; remove the declaration or name its current importer`;
  } catch {
    return "cannot parse the declared compiler API importer";
  }
};
