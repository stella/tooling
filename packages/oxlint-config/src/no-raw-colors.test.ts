/// <reference types="bun-types" />

/* oxlint-disable no-raw-colors/no-raw-colors */

import { describe, expect, test } from "bun:test";

import noRawColorsPlugin from "./no-raw-colors";

type Diagnostic = {
  node: unknown;
  messageId: "rawColor";
  data?: { match: string };
};

type TestAstNode = { type: string; parent?: unknown } & Record<string, unknown>;

type NoRawColorsRule = (typeof noRawColorsPlugin.rules)["no-raw-colors"];
type RuleVisitors = ReturnType<NoRawColorsRule["create"]>;

const reportMatches = (visit: (visitors: RuleVisitors) => void): string[] => {
  const matches: string[] = [];
  const visitors = noRawColorsPlugin.rules["no-raw-colors"].create({
    report({ data }: Diagnostic) {
      if (data === undefined) {
        throw new Error("Missing no-raw-colors diagnostic data.");
      }
      matches.push(data.match);
    },
  });
  visit(visitors);
  return matches;
};

const literalNode = (value: string, parent?: TestAstNode): TestAstNode => {
  if (parent === undefined) {
    return { type: "Literal", value };
  }
  return { parent, type: "Literal", value };
};

const templateElementNode = (
  value: string,
  parent?: TestAstNode,
): TestAstNode => {
  const templateValue = { cooked: value, raw: value };
  if (parent === undefined) {
    return { type: "TemplateElement", value: templateValue };
  }
  return { parent, type: "TemplateElement", value: templateValue };
};

const literalReports = (value: string, parent?: TestAstNode): string[] =>
  reportMatches((visitors) => {
    visitors.Literal(literalNode(value, parent));
  });

const templateElementReports = (
  value: string,
  parent?: TestAstNode,
): string[] =>
  reportMatches((visitors) => {
    visitors.TemplateElement(templateElementNode(value, parent));
  });

describe("no-raw-colors", () => {
  test("reports raw Tailwind palette utilities in class strings", () => {
    const cases = [
      { value: "bg-gray-100", match: "bg-gray-100" },
      { value: "hover:bg-gray-100", match: "hover:bg-gray-100" },
      { value: "[&_span]:bg-blue-500", match: "[&_span]:bg-blue-500" },
      { value: "!bg-red-500", match: "!bg-red-500" },
      { value: "hover:!bg-red-500", match: "hover:!bg-red-500" },
      { value: "border-t-amber-300", match: "border-t-amber-300" },
      { value: "ring-offset-slate-50", match: "ring-offset-slate-50" },
      { value: "placeholder-zinc-400", match: "placeholder-zinc-400" },
      { value: "accent-green-500", match: "accent-green-500" },
      { value: "caret-pink-500", match: "caret-pink-500" },
      { value: "decoration-blue-500", match: "decoration-blue-500" },
      { value: "drop-shadow-cyan-500", match: "drop-shadow-cyan-500" },
      { value: "inset-ring-purple-500", match: "inset-ring-purple-500" },
      { value: "inset-shadow-mauve-300", match: "inset-shadow-mauve-300" },
      { value: "marker-olive-500", match: "marker-olive-500" },
      { value: "scrollbar-thumb-mist-400", match: "scrollbar-thumb-mist-400" },
      {
        value: "scrollbar-track-taupe-100",
        match: "scrollbar-track-taupe-100",
      },
      { value: "text-shadow-red-500", match: "text-shadow-red-500" },
      { value: "text-black", match: "text-black" },
    ];

    for (const { value, match } of cases) {
      expect(literalReports(value)).toEqual([match]);
    }
  });

  test("reports every raw color token in a multi-token string", () => {
    expect(literalReports("flex bg-rose-50 text-rose-900")).toEqual([
      "bg-rose-50",
      "text-rose-900",
    ]);
  });

  test("allows semantic tokens and non-class substrings", () => {
    const values = [
      "bg-success/12 text-success",
      "bg-warning/12",
      "bg-destructive/12",
      "bg-muted text-foreground",
      "bg-white/20",
      "border-black/10",
      "bg-whitesmoke",
      "context-gray-100",
      "somebg-gray-100",
      "bg-blue-500ish",
      "bg-blue-500-token",
      "data-[status=text-red-500]:opacity-100",
    ];

    for (const value of values) {
      expect(literalReports(value)).toEqual([]);
    }
  });

  test("skips static and dynamic module sources", () => {
    const moduleSource = "bg-blue-500.svg";
    const staticSourceParents = [
      "ExportAllDeclaration",
      "ExportNamedDeclaration",
      "ImportDeclaration",
      "TSExternalModuleReference",
      "TSImportType",
    ];

    for (const type of staticSourceParents) {
      expect(literalReports(moduleSource, { type })).toEqual([]);
    }

    expect(
      literalReports(moduleSource, {
        callee: { type: "Import" },
        type: "CallExpression",
      }),
    ).toEqual([]);
    expect(literalReports(moduleSource, { type: "ImportExpression" })).toEqual(
      [],
    );
  });

  test("checks template literal text except dynamic import sources", () => {
    expect(templateElementReports("grid bg-blue-500")).toEqual(["bg-blue-500"]);

    expect(
      templateElementReports("bg-blue-500.svg", {
        parent: { type: "ImportExpression" },
        type: "TemplateLiteral",
      }),
    ).toEqual([]);
  });
});
