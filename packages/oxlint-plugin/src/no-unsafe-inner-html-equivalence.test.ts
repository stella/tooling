/// <reference types="bun-types" />

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { expect, test } from "bun:test";

const repositoryRoot = resolve(import.meta.dir, "../../../");
const fixtureRoot = join(repositoryRoot, "packages/oxlint-plugin/fixtures");
const rulePath = join(
  repositoryRoot,
  "packages/oxlint-plugin/src/no-unsafe-inner-html.ts",
);
const ruleId = "no-unsafe-inner-html/no-unsafe-inner-html";
const invalidDirective = new RegExp(
  `//\\s*oxlint-disable(?:-next-line|-line)?\\s+${ruleId.replaceAll("/", "\\/")}\\b`,
  "gu",
);
const cleanMarker = new RegExp(`expect-clean:\\s*${ruleId.replaceAll("/", "\\/")}\\b`, "gu");

type MemberEdit = {
  kind: "member";
  file: string;
  objectEnd: number;
  propertyStart: number;
  propertyEnd: number;
  propertyName: string;
  optional: boolean;
};

type AliasEdit = {
  kind: "alias";
  file: string;
  callStart: number;
  callEnd: number;
  calleeEnd: number;
  targetStart: number;
  targetEnd: number;
};

type SpreadEdit = {
  kind: "spread";
  file: string;
  callStart: number;
  callEnd: number;
  calleeEnd: number;
};

type Edit = MemberEdit | AliasEdit | SpreadEdit;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEdit = (value: unknown): value is Edit => {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "member") {
    return (
      typeof value.file === "string" &&
      typeof value.objectEnd === "number" &&
      typeof value.propertyStart === "number" &&
      typeof value.propertyEnd === "number" &&
      typeof value.propertyName === "string" &&
      typeof value.optional === "boolean"
    );
  }
  if (value.kind === "alias") {
    return (
      typeof value.file === "string" &&
      typeof value.callStart === "number" &&
      typeof value.callEnd === "number" &&
      typeof value.calleeEnd === "number" &&
      typeof value.targetStart === "number" &&
      typeof value.targetEnd === "number"
    );
  }
  return (
    value.kind === "spread" &&
    typeof value.file === "string" &&
    typeof value.callStart === "number" &&
    typeof value.callEnd === "number" &&
    typeof value.calleeEnd === "number"
  );
};

const collectorPlugin = `
const htmlMethods = new Set([
  "assign",
  "createContextualFragment",
  "insertAdjacentHTML",
  "setAttribute",
  "setHTMLUnsafe",
  "write",
  "writeln",
]);
const staticName = (node) => {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
};
const methodName = (callee) => {
  if (callee?.type !== "MemberExpression") return null;
  const name = staticName(callee.property);
  if (name === "call" || name === "apply") return methodName(callee.object);
  return name;
};
const report = (context, node, edit) =>
  context.report({ node, message: "EQUIVALENCE:" + JSON.stringify(edit) });

export default {
  rules: {
    edits: {
      meta: { type: "problem" },
      create(context) {
        return {
          MemberExpression(node) {
            if (node.computed || node.property?.type !== "Identifier") return;
            report(context, node, {
              kind: "member",
              file: context.filename,
              objectEnd: node.object.range[1],
              propertyStart: node.property.range[0],
              propertyEnd: node.property.range[1],
              propertyName: node.property.name,
              optional: node.optional === true,
            });
          },
          CallExpression(node) {
            if (node.optional === true || node.callee?.type !== "MemberExpression") return;
            const name = methodName(node.callee);
            if (!htmlMethods.has(name) || node.arguments.length === 0) return;
            report(context, node, {
              kind: "spread",
              file: context.filename,
              callStart: node.range[0],
              callEnd: node.range[1],
              calleeEnd: node.callee.range[1],
            });
            if (
              name === "assign" &&
              node.callee.object?.type === "Identifier" &&
              node.callee.object.name === "Object" &&
              node.arguments[0].type !== "SpreadElement"
            ) {
              const target = node.arguments[0];
              report(context, node, {
                kind: "alias",
                file: context.filename,
                callStart: node.range[0],
                callEnd: node.range[1],
                calleeEnd: node.callee.range[1],
                targetStart: target.range[0],
                targetEnd: target.range[1],
              });
            }
          },
        };
      },
    },
  },
};
`;

const collectMessages = (value: unknown, messages: string[]): void => {
  if (typeof value === "string") {
    if (value.startsWith("EQUIVALENCE:")) messages.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMessages(item, messages);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectMessages(item, messages);
  }
};

const parseEdits = (stdout: string): Edit[] => {
  const payload: unknown = JSON.parse(stdout);
  const messages: string[] = [];
  collectMessages(payload, messages);
  const edits: Edit[] = [];
  for (const message of messages) {
    const value: unknown = JSON.parse(message.slice("EQUIVALENCE:".length));
    if (!isEdit(value)) throw new Error(`Invalid equivalence edit: ${message}`);
    edits.push({ ...value, file: resolve(repositoryRoot, value.file) });
  }
  return edits;
};

const applyEdits = (
  source: string,
  edits: ReadonlyArray<{ start: number; end: number; text: string }>,
): string => {
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  let output = source;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of ordered) {
    if (edit.end > lastStart) {
      throw new Error(`Overlapping equivalence edits at ${edit.start}:${edit.end}`);
    }
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
    lastStart = edit.start;
  }
  return output;
};

const hasDiagnostics = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasDiagnostics);
  if (!isRecord(value)) return false;
  if (Array.isArray(value.messages) && value.messages.length > 0) return true;
  if (Array.isArray(value.diagnostics) && value.diagnostics.length > 0) return true;
  return Object.values(value).some(hasDiagnostics);
};

type RunOxlintOptions = {
  configPath: string;
  filePaths: readonly string[];
  extraArgs?: readonly string[];
};
const runOxlint = async ({
  configPath,
  filePaths,
  extraArgs = [],
}: RunOxlintOptions): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--bun",
      "oxlint",
      "-c",
      configPath,
      "--format",
      "json",
      ...extraArgs,
      ...filePaths,
    ],
    { cwd: repositoryRoot, stderr: "pipe", stdout: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const memberEdits = (source: string, edits: readonly MemberEdit[]) => {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const edit of edits) {
    const gapEnd = edit.propertyStart;
    const gap = source.slice(edit.objectEnd, gapEnd);
    const operator = edit.optional ? "?." : ".";
    const operatorIndex = gap.lastIndexOf(operator);
    if (operatorIndex < 0) throw new Error("Missing member operator");
    replacements.push({
      start: edit.objectEnd + operatorIndex,
      end: edit.propertyEnd,
      text: `${edit.optional ? "?." : ""}[${JSON.stringify(edit.propertyName)}]`,
    });
  }
  return replacements;
};

const spreadEdits = (
  source: string,
  edits: readonly SpreadEdit[],
): Array<{ start: number; end: number; text: string }> =>
  edits.flatMap((edit) => {
    const openParen = source.indexOf("(", edit.calleeEnd);
    const argsEnd = edit.callEnd - 1;
    if (
      openParen < edit.calleeEnd ||
      openParen >= argsEnd ||
      source[argsEnd] !== ")"
    ) {
      throw new Error("Missing call argument delimiters");
    }
    return [
      { start: openParen + 1, end: openParen + 1, text: "...[" },
      { start: argsEnd, end: argsEnd, text: "]" },
    ];
  });

const aliasEdits = (
  source: string,
  edits: readonly AliasEdit[],
): string => {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const [index, edit] of edits.entries()) {
    const name = `__equivalenceDomTarget${index}`;
    const target = source.slice(edit.targetStart, edit.targetEnd);
    const callPrefix = source.slice(edit.callStart, edit.targetStart);
    const callSuffix = source.slice(edit.targetEnd, edit.callEnd);
    const originalCall = `${callPrefix}${name}${callSuffix}`;
    replacements.push({
      start: edit.callStart,
      end: edit.callEnd,
      text: `(() => { const ${name} = ${target}; return ${originalCall}; })()`,
    });
  }
  return applyEdits(source, replacements);
};

const countMatches = (pattern: RegExp, source: string): number =>
  [...source.matchAll(pattern)].length;

test(
  "HTML sink fixtures keep their invalid and clean outcomes across equivalent syntax",
  async () => {
    const tempDirectory = await mkdtemp(join(fixtureRoot, "html-equivalence-"));
    const collectorPath = join(tempDirectory, "collector.mjs");
    const configPrefix = `.html-equivalence-${basename(tempDirectory)}`;
    const collectorConfigPath = join(repositoryRoot, `${configPrefix}-collector.json`);
    const ruleConfigPath = join(repositoryRoot, `${configPrefix}-rule.json`);
    const originalPaths = (await readdir(fixtureRoot))
      .filter(
        (name) =>
          name.startsWith("no-unsafe-inner-html") && name.endsWith(".fixture.tsx"),
      )
      .sort()
      .map((name) => join(fixtureRoot, name));
    expect(originalPaths.length).toBeGreaterThan(0);

    try {
      const originals = await Promise.all(
        originalPaths.map(async (path) => ({ path, source: await readFile(path, "utf8") })),
      );
      const expectedInvalidCount = originals.reduce(
        (count, { source }) => count + countMatches(invalidDirective, source),
        0,
      );
      const expectedCleanCount = originals.reduce(
        (count, { source }) => count + countMatches(cleanMarker, source),
        0,
      );
      expect(expectedInvalidCount).toBeGreaterThan(0);
      expect(expectedCleanCount).toBeGreaterThan(0);

      await writeFile(collectorPath, collectorPlugin);
      const collectorConfig = {
        categories: { correctness: "off" },
        jsPlugins: [
          { name: "equivalence-collector", specifier: collectorPath },
        ],
        rules: { "equivalence-collector/edits": "error" },
      };
      const ruleConfig = {
        categories: { correctness: "off" },
        jsPlugins: [
          { name: "no-unsafe-inner-html", specifier: rulePath },
        ],
        rules: { [ruleId]: "error" },
        overrides: [
          {
            files: [
              ...originalPaths
                .filter((path) => basename(path).includes("provenance"))
                .map((path) => relative(repositoryRoot, path)),
              `${relative(repositoryRoot, tempDirectory)}/**/*provenance*.tsx`,
            ],
            rules: {
              [ruleId]: ["error", { sanitizerPolicy: "provenance" }],
            },
          },
        ],
      };
      await Promise.all([
        writeFile(collectorConfigPath, JSON.stringify(collectorConfig)),
        writeFile(ruleConfigPath, JSON.stringify(ruleConfig)),
      ]);

      const collected = await runOxlint({
        configPath: collectorConfigPath,
        filePaths: originalPaths,
      });
      expect(collected.exitCode).toBe(1);
      const edits = parseEdits(collected.stdout);
      expect(edits.length).toBeGreaterThan(0);
      expect(edits.every((edit) => originalPaths.includes(edit.file))).toBe(true);
      const members = edits.filter(
        (edit): edit is MemberEdit => edit.kind === "member",
      );
      const aliases = edits.filter(
        (edit): edit is AliasEdit => edit.kind === "alias",
      );
      const spreads = edits.filter(
        (edit): edit is SpreadEdit => edit.kind === "spread",
      );
      expect(members.length).toBeGreaterThan(0);
      expect(aliases.length).toBeGreaterThan(0);
      expect(spreads.length).toBeGreaterThan(0);

      const generatedPaths: string[] = [];
      const generatedSources = new Map<string, string>();
      for (const original of originals) {
        const fixtureBasename = basename(original.path);
        const fileMembers = members.filter((edit) => edit.file === original.path);
        const fileAliases = aliases.filter((edit) => edit.file === original.path);
        const fileSpreads = spreads.filter((edit) => edit.file === original.path);
        const variants = [
          {
            name: "bracket",
            source: applyEdits(
              original.source,
              memberEdits(original.source, fileMembers),
            ),
          },
          {
            name: "alias",
            source: aliasEdits(original.source, fileAliases),
          },
          {
            name: "spread",
            source: applyEdits(
              original.source,
              spreadEdits(original.source, fileSpreads),
            ),
          },
        ];
        for (const variant of variants) {
          const generatedPath = join(
            tempDirectory,
            `${fixtureBasename.replace(".fixture.tsx", "")}-${variant.name}.fixture.tsx`,
          );
          expect(countMatches(invalidDirective, variant.source)).toBe(
            countMatches(invalidDirective, original.source),
          );
          expect(countMatches(cleanMarker, variant.source)).toBe(
            countMatches(cleanMarker, original.source),
          );
          generatedPaths.push(generatedPath);
          generatedSources.set(generatedPath, variant.source);
        }
      }
      expect(members.length).toBeGreaterThan(0);
      expect(aliases.length).toBeGreaterThan(0);
      expect(spreads.length).toBeGreaterThan(0);
      expect(generatedPaths).toHaveLength(originals.length * 3);
      await Promise.all(
        [...generatedSources].map(([path, source]) => writeFile(path, source)),
      );

      const verified = await runOxlint({
        configPath: ruleConfigPath,
        filePaths: [...originalPaths, ...generatedPaths],
        extraArgs: [
          "--report-unused-disable-directives-severity=error",
          "--deny-warnings",
        ],
      });
      expect(verified.exitCode).toBe(0);
      if (verified.stdout.trim() !== "") {
        const diagnostics: unknown = JSON.parse(verified.stdout);
        expect(hasDiagnostics(diagnostics)).toBe(false);
      }
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
      await Promise.all([
        rm(collectorConfigPath, { force: true }),
        rm(ruleConfigPath, { force: true }),
      ]);
    }
  },
  30_000,
);
