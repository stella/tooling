/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { libraryRules, reactCompilerRules } from "./index";

describe("React Compiler rules", () => {
  test("uses actionable category rules instead of the removed monolith", () => {
    expect("react/react-compiler" in libraryRules).toBe(false);
    expect(reactCompilerRules["react/invariant"]).toBe("off");
    expect(reactCompilerRules["react/todo"]).toBe("off");
    expect(libraryRules).toEqual(expect.objectContaining(reactCompilerRules));

    const severities = Object.values(reactCompilerRules);
    expect(severities.filter((severity) => severity === "error")).toHaveLength(
      20,
    );
    expect(severities.filter((severity) => severity === "off")).toHaveLength(2);
  });
});
