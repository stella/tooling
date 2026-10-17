import { parse, type Options } from "acorn";
import Module from "node:module";
import path from "node:path";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const packageMode = (
  files: Map<string, string>,
  file: string,
): "module" | "script" | "detect" => {
  let directory = path.posix.dirname(file);
  while (directory !== ".") {
    const source = files.get(`${directory}/package.json`);
    if (source !== undefined) {
      const manifest: unknown = JSON.parse(source);
      if (!record(manifest))
        throw new Error(`Invalid packed manifest: ${directory}`);
      if (manifest["type"] === "module") return "module";
      if (manifest["type"] === "commonjs") return "script";
      if (manifest["type"] !== undefined)
        throw new Error(`Invalid packed package type: ${directory}`);
      return "detect";
    }
    directory = path.posix.dirname(directory);
  }
  return "detect";
};

export const parseArtifactSource = (source: string, options: Options) => {
  const script = options.sourceType === "script";
  const content = script
    ? source.replace(/^\uFEFF/, "").replace(/^#![^\r\n]*/, "")
    : source;
  try {
    return parse(script ? Module.wrap(content) : content, options);
  } catch (error) {
    if (
      !script ||
      !(error instanceof SyntaxError) ||
      !record(error) ||
      typeof error["pos"] !== "number"
    )
      throw error;
    const prefixLength = Module.wrap("\u0000").indexOf("\u0000");
    const position = Math.max(
      0,
      Math.min(
        source.length,
        error["pos"] - prefixLength + source.length - content.length,
      ),
    );
    const lines = source.slice(0, position).split(/\r\n|[\n\r\u2028\u2029]/);
    const location = `(${lines.length}:${lines.at(-1)?.length ?? 0})`;
    throw new SyntaxError(error.message.replace(/\(\d+:\d+\)$/, location));
  }
};
