/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import {
  githubAutomationFileKind,
  toolchainInputKind,
} from "./toolchain-inputs";

test("both input readers exclude dependency trees for every accepted input kind", () => {
  const inputs = [
    "package.json",
    "bun.lock",
    "uv.lock",
    "pyproject.toml",
    "action.yml",
    "action.yaml",
    ".github/workflows/ci.yml",
  ];
  for (const file of inputs) {
    expect(toolchainInputKind(file)).toBeDefined();
    for (const prefix of [
      "vendor",
      "node_modules",
      "nested/vendor",
      "nested/node_modules",
    ]) {
      const excluded = `${prefix}/${file}`;
      expect(toolchainInputKind(excluded)).toBeUndefined();
      expect(githubAutomationFileKind(excluded)).toBeUndefined();
    }
  }
  expect(toolchainInputKind("")).toBeUndefined();
  expect(githubAutomationFileKind("")).toBeUndefined();
  expect(toolchainInputKind("vendor-example/package.json")).toBe("config");
  expect(githubAutomationFileKind("vendor-example/action.yml")).toBe("action");
});
