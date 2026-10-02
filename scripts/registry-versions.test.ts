import { describe, expect, test } from "bun:test";

import {
  checkReleaseVersion,
  parseNpmVersions,
} from "./lib/registry-versions";

// Registry order is publish order, not semver order.
const REGRESSED_LINE = [
  "0.1.0",
  "0.2.0",
  "0.3.0",
  "0.4.0",
  "0.5.0",
  "0.6.0",
  "0.2.1",
  "0.2.2",
];

const check = (version: string, publishedVersions: string[]) =>
  checkReleaseVersion({ version, publishedVersions });

describe("checkReleaseVersion", () => {
  test("rejects an unpublished version below the highest one", () => {
    expect(check("0.2.1", ["0.1.0", "0.6.0"])).toEqual({
      status: "regression",
      highest: "0.6.0",
    });
  });

  test("compares semver, not publish order", () => {
    expect(check("0.2.3", REGRESSED_LINE)).toEqual({
      status: "regression",
      highest: "0.6.0",
    });
    expect(check("0.7.0", REGRESSED_LINE)).toEqual({
      status: "ascending",
      highest: "0.6.0",
    });
  });

  test("compares numerically and ranks prereleases below releases", () => {
    expect(check("0.10.0", ["0.9.0"])).toEqual({
      status: "ascending",
      highest: "0.9.0",
    });
    expect(check("1.0.0-rc.1", ["1.0.0"])).toEqual({
      status: "regression",
      highest: "1.0.0",
    });
    expect(check("0.1.0", ["0.0.1-placeholder.0"])).toEqual({
      status: "ascending",
      highest: "0.0.1-placeholder.0",
    });
  });

  test("skips versions that are already published", () => {
    expect(check("0.2.2", REGRESSED_LINE)).toEqual({ status: "published" });
  });

  test("accepts a first release", () => {
    expect(check("0.1.0", [])).toEqual({ status: "first-release" });
  });
});

describe("parseNpmVersions", () => {
  test("accepts npm's single-version string and version lists", () => {
    expect(parseNpmVersions('"0.1.0"')).toEqual(["0.1.0"]);
    expect(parseNpmVersions('["0.1.0","0.2.0"]')).toEqual(["0.1.0", "0.2.0"]);
  });

  test("rejects unexpected payloads", () => {
    expect(() => parseNpmVersions('{"error":{}}')).toThrow();
    expect(() => parseNpmVersions("[1]")).toThrow();
  });
});
