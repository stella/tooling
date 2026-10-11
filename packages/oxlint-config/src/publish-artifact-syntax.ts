import { parse, type Options } from "acorn";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { wrap } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  publishedNodeTargetSupportsConsumer,
  type PublishTarget,
} from "./publish-contract";

const command = promisify(execFile);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const javascript = /\.(?:js|mjs|cjs)$/i;

const syntaxYears = new Map(
  Object.entries({
    es5: 5,
    es2015: 2015,
    es2016: 2016,
    es2017: 2017,
    es2018: 2018,
    es2019: 2019,
    es2020: 2020,
    es2021: 2021,
    es2022: 2022,
    es2023: 2023,
    es2024: 2024,
    es2025: 2025,
  } as const satisfies Record<string, Options["ecmaVersion"]>),
);

/** Explicit ECMAScript targets bound syntax; unbounded targets use native Node. */
export const artifactEcmaVersion = ({
  target,
  node,
}: {
  target: PublishTarget;
  node: string;
}): Options["ecmaVersion"] => {
  if (target.type === "types-only") return "latest";
  if (target.targets.length === 0)
    throw new Error("Packed JavaScript requires a declared target");
  let version: Options["ecmaVersion"] = "latest";
  for (const identifier of target.targets) {
    if (identifier === "esnext") continue;
    const year = syntaxYears.get(identifier);
    if (year !== undefined) {
      if (version === "latest" || year < version) version = year;
      continue;
    }
    if (publishedNodeTargetSupportsConsumer({ target: identifier, node }))
      continue;
    throw new Error(
      `Unsupported packed JavaScript syntax target ${identifier}; use an explicit ECMAScript year or a supported Node target`,
    );
  }
  return version;
};

const packedBinFiles = (files: Map<string, string>) => {
  const result = new Set<string>();
  for (const [file, source] of files) {
    if (path.posix.basename(file) !== "package.json") continue;
    const manifest: unknown = JSON.parse(source);
    if (!record(manifest)) throw new Error(`Invalid packed manifest: ${file}`);
    const bin = manifest["bin"];
    if (bin === undefined) continue;
    let entries: unknown[] | undefined;
    if (typeof bin === "string") entries = [bin];
    else if (record(bin)) entries = Object.values(bin);
    if (entries === undefined)
      throw new Error(`Unsupported packed bin declaration: ${file}`);
    for (const entry of entries) {
      if (
        typeof entry !== "string" ||
        entry === "" ||
        path.posix.isAbsolute(entry) ||
        entry.includes("\\") ||
        entry.split("/").includes("..")
      )
        throw new Error(`Unsafe packed bin declaration: ${file}`);
      result.add(path.posix.join(path.posix.dirname(file), entry));
    }
  }
  return result;
};
const syntaxFiles = (files: Map<string, string>) => {
  const bins = packedBinFiles(files);
  for (const file of bins) {
    const source = files.get(file);
    if (source === undefined)
      throw new Error(`Missing packed executable: ${file}`);
    if (
      !javascript.test(file) &&
      !/^#!(?:[^\n]*\/node|\/usr\/bin\/env(?: -S)? node)(?:[ \r\n]|$)/.test(
        source,
      )
    )
      throw new Error(`Unsupported packed executable language: ${file}`);
  }
  return [
    ...new Set(
      [...files.keys()]
        .filter((file) => javascript.test(file))
        .concat([...bins]),
    ),
  ];
};

const packageMode = (
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

type ArtifactSyntaxOptions = {
  files: Map<string, string>;
  target: PublishTarget;
  node: string;
};

const parseArtifactSource = (source: string, options: Options) => {
  const script = options.sourceType === "script";
  const content = script
    ? source.replace(/^\uFEFF/, "").replace(/^#![^\r\n]*/, "")
    : source;
  try {
    return parse(script ? wrap(content) : content, options);
  } catch (error) {
    if (
      !script ||
      !(error instanceof SyntaxError) ||
      !record(error) ||
      typeof error["pos"] !== "number"
    )
      throw error;
    const prefixLength = wrap("\u0000").indexOf("\u0000");
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

/** Enumerate all chunks and bins, including JavaScript outside declared exports. */
export const assertPackedArtifactSyntax = ({
  files,
  target,
  node,
}: ArtifactSyntaxOptions) => {
  const ecmaVersion = artifactEcmaVersion({ target, node });
  const selected = syntaxFiles(files);
  if (target.type === "types-only" && selected.length > 0)
    throw new Error(`Types-only artifact contains JavaScript: ${selected[0]}`);
  for (const file of selected) {
    const source = files.get(file);
    if (source === undefined)
      throw new Error(`Missing packed JavaScript: ${file}`);
    let mode = packageMode(files, file);
    if (/\.mjs$/i.test(file)) mode = "module";
    if (/\.cjs$/i.test(file)) mode = "script";
    const parseMode = (sourceType: "script" | "module") => {
      const tree = parseArtifactSource(source, {
        ecmaVersion,
        sourceType,
        allowHashBang: true,
        allowReturnOutsideFunction: sourceType === "script",
      });
      // Acorn permits module declarations independently of ecmaVersion.
      if (
        ecmaVersion === 5 &&
        tree.body.some((item) => /^(?:Import|Export)/.test(item.type))
      )
        throw new Error("Module declarations exceed ES5");
    };
    try {
      if (mode === "detect") {
        try {
          parseMode("script");
        } catch {
          parseMode("module");
        }
      } else parseMode(mode);
    } catch (error) {
      throw new Error(
        `Packed JavaScript ${file} exceeds its declared syntax target: ${String(error)}`,
      );
    }
  }
};

const archiveMembers = (members: readonly string[]) => {
  const seen = new Set<string>();
  for (const file of members) {
    const parts = file.split("/");
    if (
      !file.startsWith("package/") ||
      file.includes("\\") ||
      file
        .split("")
        .some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
      parts.some((part) => part === ".." || part === ".") ||
      parts.slice(0, -1).some((part) => part === "") ||
      seen.has(file)
    )
      throw new Error(`Unsupported packed artifact member: ${file}`);
    seen.add(file);
  }
  return members;
};

type CheckPackedArtifactOptions = ArtifactSyntaxOptions & {
  executable: string;
};
export const checkPackedJavaScriptWithNode = async ({
  files,
  target,
  node,
  executable,
}: CheckPackedArtifactOptions) => {
  assertPackedArtifactSyntax({ files, target, node });
  archiveMembers([...files.keys()]);
  const scratch = await mkdtemp(path.join(tmpdir(), "stll-artifact-syntax-"));
  try {
    for (const [file, source] of files) {
      const destination = path.join(scratch, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, source);
    }
    for (const file of syntaxFiles(files)) {
      try {
        await command(executable, ["--check", path.join(scratch, file)], {
          cwd: scratch,
          env: { PATH: "/usr/bin:/bin", HOME: scratch },
        });
      } catch (error) {
        throw new Error(
          `Packed JavaScript ${file} is incompatible with consumer Node ${node}: ${String(error)}`,
        );
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

/** Read bytes without extracting archive-controlled paths or links. */
export const readPackedSyntaxFiles = async (archive: string) => {
  const { stdout: listing } = await command("tar", ["-tzf", archive], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const files = new Map<string, string>();
  const members = archiveMembers(
    listing.split("\n").filter((entry) => entry !== ""),
  );
  const read = async (file: string) => {
    if (!members.includes(file))
      throw new Error(`Missing packed syntax input: ${file}`);
    const { stdout: metadata } = await command("tar", ["-tvzf", archive, file]);
    if (
      !metadata.startsWith("-") ||
      metadata.trimEnd().split("\n").length !== 1
    )
      throw new Error(`Packed syntax input must be a regular file: ${file}`);
    const { stdout } = await command("tar", ["-xOf", archive, file], {
      maxBuffer: 16 * 1024 * 1024,
    });
    files.set(file, stdout);
  };
  for (const file of members)
    if (javascript.test(file) || path.posix.basename(file) === "package.json")
      await read(file);
  for (const file of packedBinFiles(files))
    if (!files.has(file)) await read(file);
  return files;
};
