/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import {
  githubAutomationFileKind,
  isDependabotGithubActionsPath,
  isDockerDefinitionPath,
  pythonDependencyManifestKind,
  isPythonDependencyManifest,
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

test("Python dependency filename classification is shared and scoped to manifests", () => {
  for (const file of [
    "pyproject.toml",
    "requirements.txt",
    "requirements_dev.txt",
    "python/requirements.prod.txt",
    "tools/requirements-ci.txt",
  ]) {
    expect(isPythonDependencyManifest(file)).toBe(true);
    expect(toolchainInputKind(file)).toBe("config");
    for (const prefix of [
      "vendor",
      "node_modules",
      "nested/vendor",
      "nested/node_modules",
    ]) {
      expect(isPythonDependencyManifest(`${prefix}/${file}`)).toBe(false);
      expect(toolchainInputKind(`${prefix}/${file}`)).toBeUndefined();
    }
  }
  for (const file of [
    "contract.txt",
    "legislation.txt",
    "docs/act.txt",
    "requirements.md",
    "requirements_dev.txt.bak",
  ]) {
    expect(isPythonDependencyManifest(file)).toBe(false);
    expect(toolchainInputKind(file)).toBeUndefined();
  }
});

test("Pipenv lockfiles provide ecosystem presence without dependency graph reads", () => {
  expect(pythonDependencyManifestKind("python/Pipfile")).toBe("pipfile");
  expect(toolchainInputKind("python/Pipfile")).toBe("config");
  expect(pythonDependencyManifestKind("python/Pipfile.lock")).toBe(
    "pipfile-lock",
  );
  expect(toolchainInputKind("python/Pipfile.lock")).toBe("presence");
});

test("runtime metadata coverage includes nested actions while Dependabot uses documented roots", () => {
  for (const file of [
    "action.yml",
    "action.yaml",
    ".github/workflows/ci.yml",
  ]) {
    expect(isDependabotGithubActionsPath(file)).toBe(true);
    expect(toolchainInputKind(file)).toBe("config");
  }
  for (const file of ["nested/action.yml", "nested/action.yaml"]) {
    expect(githubAutomationFileKind(file)).toBe("action");
    expect(isDependabotGithubActionsPath(file)).toBe(false);
    expect(toolchainInputKind(file)).toBe("config");
  }
});

test("all Docker definition suffixes remain in the shared reader and runtime class", () => {
  for (const name of [
    "Dockerfile",
    "Dockerfile.production",
    "Containerfile",
    "Containerfile.production",
  ]) {
    expect(isDockerDefinitionPath(`image/${name}`)).toBe(true);
    expect(toolchainInputKind(`image/${name}`)).toBe("config");
    for (const prefix of ["vendor", "node_modules"]) {
      expect(isDockerDefinitionPath(`${prefix}/${name}`)).toBe(false);
      expect(toolchainInputKind(`${prefix}/${name}`)).toBeUndefined();
    }
  }
});

test("pnpm workspace inputs use the producer's YAML filename", () => {
  expect(toolchainInputKind("pnpm-workspace.yaml")).toBe("config");
  expect(toolchainInputKind("nested/pnpm-workspace.yaml")).toBe("config");
  expect(toolchainInputKind("pnpm-workspace.yml")).toBeUndefined();
  for (const prefix of ["vendor", "node_modules", "nested/vendor"])
    expect(toolchainInputKind(`${prefix}/pnpm-workspace.yaml`)).toBeUndefined();
});
