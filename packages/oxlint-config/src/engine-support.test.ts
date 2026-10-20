import { expect, test } from "bun:test";

import { checkEngineSupport, type EnginePackage } from "./engine-support";

const pkg = (
  name: string,
  node: string | undefined,
  changesetsManaged = true,
): EnginePackage => ({
  name,
  ...(node === undefined ? {} : { node }),
  changesetsManaged,
});

test("an ignored package that narrows support is not checked", () => {
  const base = new Map([["platform", pkg("platform", ">=18", false)]]);
  const head = new Map([["platform", pkg("platform", ">=20", false)]]);

  expect(checkEngineSupport({ base, head, majorReleases: new Set() })).toEqual(
    [],
  );
});

test("managed narrowing requires that package's major bump", () => {
  const base = new Map([["library", pkg("library", ">=18")]]);
  const head = new Map([["library", pkg("library", ">=20")]]);
  expect(checkEngineSupport({ base, head, majorReleases: new Set() })).toEqual([
    {
      packageName: "library",
      baseRange: ">=18",
      headRange: ">=20",
    },
  ]);
  expect(
    checkEngineSupport({
      base,
      head,
      majorReleases: new Set(["library"]),
    }),
  ).toEqual([]);
});

test("widened and newly published packages do not require releases", () => {
  const base = new Map([["library", pkg("library", ">=20")]]);
  const head = new Map([
    ["library", pkg("library", ">=18")],
    ["new", pkg("new", ">=22")],
  ]);
  expect(checkEngineSupport({ base, head, majorReleases: new Set() })).toEqual(
    [],
  );
});

test("adding an engine range narrows an unrestricted package", () => {
  const base = new Map([["library", pkg("library", undefined)]]);
  const head = new Map([["library", pkg("library", ">=20")]]);
  expect(
    checkEngineSupport({
      base,
      head,
      majorReleases: new Set(["library"]),
    }),
  ).toEqual([]);
});
