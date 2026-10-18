/// <reference types="bun-types" />

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { expect, test } from "bun:test";
import { DOM_ELEMENT_PRODUCERS } from "./no-unsafe-inner-html.ts";

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

type JsxEdit = {
  kind: "jsx";
  file: string;
  start: number;
  end: number;
  reactText: string;
  jsxText: string;
  elementCount: number;
};

type JsxInventoryEdit = {
  kind: "jsx-inventory";
  file: string;
  elementCount: number;
};

type Edit = MemberEdit | AliasEdit | SpreadEdit | JsxEdit | JsxInventoryEdit;

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
  if (value.kind === "jsx") {
    return (
      typeof value.file === "string" &&
      typeof value.start === "number" &&
      typeof value.end === "number" &&
      typeof value.reactText === "string" &&
      typeof value.jsxText === "string" &&
      typeof value.elementCount === "number"
    );
  }
  if (value.kind === "jsx-inventory") {
    return (
      typeof value.file === "string" &&
      typeof value.elementCount === "number"
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

const collectorPlugin = String.raw`
const htmlMethods = new Set([
  "assign",
  "createContextualFragment",
  "insertAdjacentHTML",
  "setAttribute",
  "setHTMLUnsafe",
  "write",
  "writeln",
]);
const elementFactories = new Set([
  "createElement",
  "jsx",
  "jsxs",
  "jsxDEV",
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
const jsxKinds = new Set(["JSXElement", "JSXFragment"]);
const jsxText = (context, node) => context.sourceCode.getText(node);
const jsxTagName = (context, node) => {
  const text = jsxText(context, node);
  return node.type === "JSXNamespacedName" ||
    (node.type === "JSXIdentifier" && /^[a-z]/u.test(node.name))
    ? JSON.stringify(text)
    : text;
};
const jsxAttributeName = (context, node) => {
  const text = jsxText(context, node);
  return JSON.stringify(text);
};
const applySourceEdits = (source, edits, base) => {
  let output = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    output =
      output.slice(0, edit.start - base) +
      edit.text +
      output.slice(edit.end - base);
  }
  return output;
};
const renderExpression = (context, node, mode) => {
  if (jsxKinds.has(node.type)) return renderJsx(context, node, mode);
  const source = jsxText(context, node);
  const replacements = [];
  let elementCount = 0;
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (jsxKinds.has(value.type)) {
      const rendered = renderJsx(context, value, mode);
      replacements.push({
        start: value.range[0],
        end: value.range[1],
        text: rendered.text,
      });
      elementCount += rendered.elementCount;
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "parent" && key !== "loc" && key !== "range") visit(child);
    }
  };
  for (const [key, value] of Object.entries(node)) {
    if (key !== "parent" && key !== "loc" && key !== "range") visit(value);
  }
  return {
    text: applySourceEdits(source, replacements, node.range[0]),
    elementCount,
  };
};
const renderJsx = (context, node, mode) => {
  const isElement = node.type === "JSXElement";
  const opening = isElement ? node.openingElement : null;
  const name = isElement ? jsxTagName(context, opening.name) : "React.Fragment";
  const properties = [];
  let elementCount = isElement ? 1 : 0;
  if (isElement) {
    for (const attribute of opening.attributes) {
      if (attribute.type === "JSXSpreadAttribute") {
        const spreadValue = renderExpression(context, attribute.argument, mode);
        properties.push("..." + spreadValue.text);
        elementCount += spreadValue.elementCount;
        continue;
      }
      let value = "true";
      if (attribute.value?.type === "Literal") {
        value = JSON.stringify(attribute.value.value);
      } else if (attribute.value?.type === "JSXExpressionContainer") {
        const expression = renderExpression(
          context,
          attribute.value.expression,
          mode,
        );
        value = "(" + expression.text + ")";
        elementCount += expression.elementCount;
      } else if (attribute.value !== null && attribute.value !== undefined) {
        throw new Error("Unsupported JSX attribute value: " + attribute.value.type);
      }
      properties.push(jsxAttributeName(context, attribute.name) + ": " + value);
    }
  }
  const children = [];
  for (const child of node.children) {
    if (child.type === "JSXText") {
      if (child.value !== "") children.push(JSON.stringify(child.value));
    } else if (child.type === "JSXExpressionContainer") {
      if (child.expression.type === "JSXEmptyExpression") {
        const comment = context.sourceCode.text.slice(
          child.range[0] + 1,
          child.range[1] - 1,
        );
        children.push("null " + comment + "\n");
      } else {
        const expression = renderExpression(context, child.expression, mode);
        children.push(expression.text);
        elementCount += expression.elementCount;
      }
    } else if (child.type === "JSXSpreadChild") {
      const expression = renderExpression(context, child.expression, mode);
      children.push("..." + expression.text);
      elementCount += expression.elementCount;
    } else if (jsxKinds.has(child.type)) {
      const rendered = renderJsx(context, child, mode);
      children.push(rendered.text);
      elementCount += rendered.elementCount;
    }
  }
  const props = properties.length === 0 ? null : "{" + properties.join(", ") + "}";
  if (mode === "react") {
    const args = [name, props ?? "null", ...children];
    return {
      text: "React.createElement(" + args.join(", ") + ")",
      elementCount,
    };
  }
  const jsxProperties = properties.slice();
  if (children.length > 0) {
    jsxProperties.push(
      "children: " +
        (children.length === 1 ? children[0] : "[" + children.join(", ") + "]"),
    );
  }
  return {
    text: "jsx(" + name + ", {" + jsxProperties.join(", ") + "})",
    elementCount,
  };
};
const hasJsxAncestor = (node) => {
  let parent = node.parent;
  while (parent) {
    if (jsxKinds.has(parent.type)) return true;
    parent = parent.parent;
  }
  return false;
};
const report = (context, node, edit) =>
  context.report({ node, message: "EQUIVALENCE:" + JSON.stringify(edit) });

export default {
  rules: {
    edits: {
      meta: { type: "problem" },
      create(context) {
        let visitedJsxElements = 0;
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
            if (node.optional === true) return;
            const name =
              node.callee?.type === "MemberExpression"
                ? methodName(node.callee)
                : node.callee?.type === "Identifier"
                  ? node.callee.name
                  : null;
            const isHtmlSink =
              node.callee?.type === "MemberExpression" &&
              htmlMethods.has(name);
            const isElementFactory =
              (node.callee?.type === "Identifier" &&
                elementFactories.has(node.callee.name)) ||
              (node.callee?.type === "MemberExpression" &&
                name === "createElement" &&
                node.callee.object?.type === "Identifier" &&
                node.callee.object.name === "React");
            if (
              (!isHtmlSink && !isElementFactory) ||
              node.arguments.length === 0
            ) {
              return;
            }
            report(context, node, {
              kind: "spread",
              file: context.filename,
              callStart: node.range[0],
              callEnd: node.range[1],
              calleeEnd: node.callee.range[1],
            });
            if (
              name === "assign" &&
              node.callee?.type === "MemberExpression" &&
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
          JSXElement(node) {
            visitedJsxElements += 1;
            if (hasJsxAncestor(node)) return;
            const react = renderJsx(context, node, "react");
            const jsx = renderJsx(context, node, "jsx");
            if (react.elementCount !== jsx.elementCount) {
              throw new Error("JSX equivalence renderers missed an element");
            }
            report(context, node, {
              kind: "jsx",
              file: context.filename,
              start: node.range[0],
              end: node.range[1],
              reactText: react.text,
              jsxText: jsx.text,
              elementCount: react.elementCount,
            });
          },
          JSXFragment(node) {
            if (hasJsxAncestor(node)) return;
            const react = renderJsx(context, node, "react");
            const jsx = renderJsx(context, node, "jsx");
            if (react.elementCount !== jsx.elementCount) {
              throw new Error("JSX equivalence renderers missed an element");
            }
            report(context, node, {
              kind: "jsx",
              file: context.filename,
              start: node.range[0],
              end: node.range[1],
              reactText: react.text,
              jsxText: jsx.text,
              elementCount: react.elementCount,
            });
          },
          "Program:exit"(node) {
            report(context, node, {
              kind: "jsx-inventory",
              file: context.filename,
              elementCount: visitedJsxElements,
            });
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
  const outputDirectory = await mkdtemp(join(tmpdir(), "html-equivalence-output-"));
  const stdoutPath = join(outputDirectory, "stdout.json");
  const stderrPath = join(outputDirectory, "stderr.txt");
  try {
    // Regular files retain complete native CLI output even when it exceeds pipe capacity.
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
      {
        cwd: repositoryRoot,
        stdout: Bun.file(stdoutPath),
        stderr: Bun.file(stderrPath),
      },
    );
    const exitCode = await child.exited;
    const [stdout, stderr] = await Promise.all([
      readFile(stdoutPath, "utf8"),
      readFile(stderrPath, "utf8"),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
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

type DomElementProducer = (typeof DOM_ELEMENT_PRODUCERS)[number];

const producerReceivers = (
  receiver: DomElementProducer["receiver"],
): readonly string[] => {
  switch (receiver) {
    case "document":
      return ["document"];
    case "element":
      return ['document.createElement("div")'];
    case "either":
      return [
        "document",
        'document.createElement("div")',
      ];
    default: {
      const exhaustive: never = receiver;
      throw new Error(`Unknown DOM producer receiver: ${String(exhaustive)}`);
    }
  }
};

type CallableDomProducer = Extract<
  DomElementProducer,
  { kind: "method" | "collection" }
>;
const producerArguments = {
  createElement: '"div"',
  createElementNS: '"http://www.w3.org/1999/xhtml", "div"',
  getElementById: '"fixture"',
  querySelector: '"div"',
  closest: '"div"',
  elementFromPoint: "0, 0",
  getElementsByClassName: '"fixture"',
  getElementsByTagName: '"div"',
  getElementsByTagNameNS: '"http://www.w3.org/1999/xhtml", "div"',
  getElementsByName: '"fixture"',
  querySelectorAll: '"div"',
} as const satisfies Record<CallableDomProducer["name"], string>;

const producerExpressions = (entry: DomElementProducer): string[] => {
  const expressions: string[] = [];
  for (const receiver of producerReceivers(entry.receiver)) {
    switch (entry.kind) {
      case "property":
        expressions.push(`${receiver}.${entry.name}`);
        break;
      case "method":
        expressions.push(`${receiver}.${entry.name}(${producerArguments[entry.name]})`);
        break;
      case "collection": {
        const collection = `${receiver}.${entry.name}(${producerArguments[entry.name]})`;
        expressions.push(`${collection}[0]`, `${collection}.item(0)`);
        break;
      }
      default: {
        const exhaustive: never = entry;
        throw new Error(`Unknown DOM producer kind: ${String(exhaustive)}`);
      }
    }
  }
  return expressions;
};

const producerCorpus = (): {
  source: string;
  invalidCount: number;
  producerIds: string[];
} => {
  const lines = [
    'declare const payload: object;',
    'declare const rawHtml: string;',
    'declare const config: Record<string, unknown>;',
    "",
  ];
  let invalidCount = 0;
  const producerIds: string[] = [];
  for (const entry of DOM_ELEMENT_PRODUCERS) {
    const producerId = `${entry.receiver}:${entry.kind}:${entry.name}`;
    producerIds.push(producerId);
    const expressions = producerExpressions(entry);
    expect(expressions.length).toBeGreaterThan(0);
    for (const [index, target] of expressions.entries()) {
      lines.push(
        `// DOM producer case ${entry.receiver}.${entry.name} (${entry.kind}) #${index + 1}`,
        `// oxlint-disable-next-line ${ruleId} -- recognized DOM target with opaque HTML source`,
        `Object.assign(${target}, payload);`,
      );
      invalidCount += 1;
    }
    if (entry.kind === "collection") {
      for (const receiver of producerReceivers(entry.receiver)) {
        const collection = `${receiver}.${entry.name}(${producerArguments[entry.name]})`;
        for (const access of ["elements[0]", "elements.item(0)"]) {
          lines.push(
            "{",
            `const elements = ${collection};`,
            `// oxlint-disable-next-line ${ruleId} -- stable collection binding retains indexed element provenance`,
            `Object.assign(${access}, payload);`,
            "}",
          );
          invalidCount += 1;
        }
      }
    }
  }
  const cleanTargets = [
    "config.body",
    'config.querySelector("div")',
    'config.getElementsByTagName("div")[0]',
    'config.getElementsByTagName("div").item(0)',
  ];
  for (const target of cleanTargets) {
    lines.push(
      `// expect-clean: ${ruleId} -- non-DOM receiver remains outside producer table`,
      `Object.assign(${target}, payload);`,
    );
  }
  lines.push(
    "// safe-html: fixture waiver is consumed by the first, statically safe write",
    'document.write(""); document.write(rawHtml); // oxlint-disable-line ' +
      `${ruleId} -- second same-line document.write sink is intentionally opaque`,
  );
  invalidCount += 1;
  return {
    source: `${lines.join("\n")}\n`,
    invalidCount,
    producerIds,
  };
};

test(
  "HTML sink fixtures keep their invalid and clean outcomes across equivalent syntax",
  async () => {
    const {
      source: producerSource,
      invalidCount: producerInvalidCount,
      producerIds,
    } = producerCorpus();
    const expectedProducerIds = DOM_ELEMENT_PRODUCERS.map(
      ({ receiver, kind, name }) => `${receiver}:${kind}:${name}`,
    );
    expect([...new Set(producerIds)].sort()).toEqual(
      [...new Set(expectedProducerIds)].sort(),
    );
    expect(producerIds).toHaveLength(expectedProducerIds.length);
    expect(new Set(producerIds).size).toBe(DOM_ELEMENT_PRODUCERS.length);
    const tempDirectory = await mkdtemp(join(fixtureRoot, "html-equivalence-"));
    const collectorPath = join(tempDirectory, "collector.mjs");
    const configPrefix = `.html-equivalence-${basename(tempDirectory)}`;
    const collectorConfigPath = join(repositoryRoot, `${configPrefix}-collector.json`);
    const ruleConfigPath = join(repositoryRoot, `${configPrefix}-rule.json`);
    const producerCorpusPath = join(tempDirectory, "dom-producer-corpus.fixture.tsx");

    try {
      await writeFile(producerCorpusPath, producerSource);
      const originalPaths = (await readdir(fixtureRoot))
        .filter(
          (name) =>
            name.startsWith("no-unsafe-inner-html") &&
            name.endsWith(".fixture.tsx"),
        )
        .sort()
        .map((name) => join(fixtureRoot, name));
      expect(originalPaths.length).toBeGreaterThan(0);
      originalPaths.push(producerCorpusPath);
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
      expect(
        countMatches(invalidDirective, producerSource),
      ).toBe(producerInvalidCount);

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
      const jsxRoots = edits.filter(
        (edit): edit is JsxEdit => edit.kind === "jsx",
      );
      const jsxInventory = edits.filter(
        (edit): edit is JsxInventoryEdit => edit.kind === "jsx-inventory",
      );
      expect(members.length).toBeGreaterThan(0);
      expect(aliases.length).toBeGreaterThan(0);
      expect(spreads.length).toBeGreaterThan(0);
      expect(jsxRoots.length).toBeGreaterThan(0);
      expect(jsxInventory).toHaveLength(originalPaths.length);
      expect(
        jsxRoots.reduce((count, edit) => count + edit.elementCount, 0),
      ).toBe(
        jsxInventory.reduce((count, edit) => count + edit.elementCount, 0),
      );

      const generatedPaths: string[] = [];
      const generatedSources = new Map<string, string>();
      for (const original of originals) {
        const fixtureBasename = basename(original.path);
        const fileMembers = members.filter((edit) => edit.file === original.path);
        const fileAliases = aliases.filter((edit) => edit.file === original.path);
        const fileSpreads = spreads.filter((edit) => edit.file === original.path);
        const fileJsxRoots = jsxRoots.filter((edit) => edit.file === original.path);
        const inventory = jsxInventory.find((edit) => edit.file === original.path);
        if (inventory === undefined) {
          throw new Error(`Missing JSX inventory for ${original.path}`);
        }
        expect(
          fileJsxRoots.reduce((count, edit) => count + edit.elementCount, 0),
        ).toBe(inventory.elementCount);
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
          {
            name: "react-create-element",
            source: applyEdits(
              original.source,
              fileJsxRoots.map((edit) => ({
                start: edit.start,
                end: edit.end,
                text: edit.reactText,
              })),
            ),
          },
          {
            name: "jsx-call",
            source: applyEdits(
              original.source,
              fileJsxRoots.map((edit) => ({
                start: edit.start,
                end: edit.end,
                text: edit.jsxText,
              })),
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
      expect(jsxRoots.length).toBeGreaterThan(0);
      expect(generatedPaths).toHaveLength(originals.length * 5);
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
