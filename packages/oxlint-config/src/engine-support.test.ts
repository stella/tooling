import { expect, test } from "bun:test";

import { checkEngineSupport, type EnginePackage } from "./engine-support";

const pkg = (
  name: string,
  node: string | undefined,
  changesetsManaged = true,
  optionalDependencies: string[] = [],
): EnginePackage => ({
  name,
  ...(node === undefined ? {} : { node }),
  changesetsManaged,
  optionalDependencies,
});

test("managed packages resolve themselves despite multiple optional dependents", () => {
  const base = new Map([["library", pkg("library", ">=18")]]);
  const head = new Map([
    ["library", pkg("library", ">=20")],
    ["first", pkg("first", ">=18", true, ["library"])],
    ["second", pkg("second", ">=18", true, ["library"])],
  ]);

  expect(
    checkEngineSupport({
      base,
      head,
      majorReleases: new Set(["library"]),
    }),
  ).toEqual([]);
  expect(checkEngineSupport({ base, head, majorReleases: new Set() })).toEqual([
    {
      packageName: "library",
      baseRange: ">=18",
      headRange: ">=20",
      releasingPackage: "library",
    },
  ]);
});

test("unmanaged packages reject multiple candidate owners", () => {
  const base = new Map([["platform", pkg("platform", ">=18", false)]]);
  const head = new Map([
    ["platform", pkg("platform", ">=20", false)],
    ["first", pkg("first", ">=18", true, ["platform"])],
    ["second", pkg("second", ">=18", true, ["platform"])],
  ]);

  expect(() =>
    checkEngineSupport({ base, head, majorReleases: new Set() }),
  ).toThrow("Multiple releasing packages declare platform: first, second");
});

test("engine support decisions require the releasing package's major bump", () => {
  const base = new Map([
    ["library", pkg("library", ">=18")],
    ["platform", pkg("platform", ">=18", false)],
  ]);
  const head = new Map([
    ["library", pkg("library", ">=20")],
    ["platform", pkg("platform", ">=20", false)],
    ["owner", pkg("owner", ">=18", true, ["platform"])],
  ]);
  expect(
    checkEngineSupport({ base, head, majorReleases: new Set(["owner"]) }),
  ).toEqual([
    {
      packageName: "library",
      baseRange: ">=18",
      headRange: ">=20",
      releasingPackage: "library",
    },
  ]);
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
