import { extname } from "node:path";

export const scriptSourceExtensions = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
} as const;

const extensionKinds = new Map(Object.entries(scriptSourceExtensions));

/** Share source classification between lint ownership and script command discovery. */
export const scriptSourceKind = (file: string) =>
  extensionKinds.get(extname(file));
