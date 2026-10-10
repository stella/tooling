/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { parseDocument } from "yaml";

import toolchain from "../toolchain.json";
import { containerDocumentImages } from "./toolchain-container-inputs";
import { generateDependabotConfig } from "./toolchain-dependabot";
import {
  githubAutomationFileKind,
  isDependabotGithubActionsPath,
  isDockerDefinitionPath,
  pythonDependencyManifestKind,
  isPythonDependencyManifest,
  toolchainInputKind,
} from "./toolchain-inputs";
import { parseToolchainPolicy } from "./toolchain-schema";

test("both input readers exclude dependency trees for every accepted input kind", () => {
  const inputs = ["package.json", "bun.lock", "uv.lock", "pyproject.toml"];
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

test("tracked executable action metadata remains discoverable under dependency-named directories", () => {
  for (const prefix of [
    "vendor",
    "node_modules",
    "nested/vendor",
    "nested/node_modules",
  ]) {
    for (const name of ["action.yml", "action.yaml"]) {
      expect(githubAutomationFileKind(`${prefix}/${name}`)).toBe("action");
      expect(toolchainInputKind(`${prefix}/${name}`)).toBe("config");
      expect(isDependabotGithubActionsPath(`${prefix}/${name}`)).toBe(false);
    }
  }
});

test("Python dependency filename classification is shared and scoped to manifests", () => {
  for (const file of [
    "pyproject.toml",
    "requirements.txt",
    "requirements_dev.txt",
    "python/requirements.prod.txt",
    "tools/requirements-ci.txt",
    "requirements.in",
    "tools/requirements_dev.in",
    "setup.py",
    "python/setup.cfg",
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
    "contract.in",
    "setup.py.bak",
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
    "app.Dockerfile",
    "app.api.Dockerfile",
    "Dockerfile.prod.build",
    "dockerfile.dev",
    "app.CONTAINERFILE.dev",
  ]) {
    expect(isDockerDefinitionPath(`image/${name}`)).toBe(true);
    expect(toolchainInputKind(`image/${name}`)).toBe("config");
    for (const prefix of ["vendor", "node_modules"]) {
      expect(isDockerDefinitionPath(`${prefix}/${name}`)).toBe(false);
      expect(toolchainInputKind(`${prefix}/${name}`)).toBeUndefined();
    }
  }
});

test("Docker source and documentation names do not create runtime or update inputs", () => {
  const policy = parseToolchainPolicy(toolchain).dependabot;
  for (const name of [
    "generate-dockerfile.ts",
    "dockerfile.md",
    "generate-containerfile.ts",
    "containerfile.md",
    "Dockerfile.ts",
    "Containerfile.mdx",
    "Dockerfile.cpp",
    "containerfile.rb",
    "Containerfile.css",
    "Dockerfile..prod",
    "app..Dockerfile",
    "dockerfiles",
    "mydockerfile",
    "containerfilename",
  ]) {
    for (const prefix of ["scripts", "docs", "dockerfile-notes"]) {
      const file = `${prefix}/${name}`;
      expect(isDockerDefinitionPath(file)).toBe(false);
      expect(toolchainInputKind(file)).toBeUndefined();
      expect(
        parseDocument(
          generateDependabotConfig({
            files: { [file]: "FROM node:latest" },
            policy,
          }),
        ).getIn(["updates", 0]),
      ).toBeUndefined();
    }
  }
});

test("pnpm workspace inputs use the producer's YAML filename", () => {
  expect(toolchainInputKind("pnpm-workspace.yaml")).toBe("config");
  expect(toolchainInputKind("nested/pnpm-workspace.yaml")).toBe("config");
  const policy = parseToolchainPolicy(toolchain).dependabot;
  for (const prefix of ["", "nested/"]) {
    const member = `${prefix}packages/app/package.json`;
    const directory = prefix === "" ? "/" : "/nested";
    const memberDirectory = `/${prefix}packages/app`;
    for (const extension of ["yaml", "yml"]) {
      const file = `${prefix}pnpm-workspace.${extension}`;
      // Generic YAML must be read before deciding whether it is a container artifact.
      expect(toolchainInputKind(file)).toBe("config");
      expect(
        containerDocumentImages({ packages: ["packages/*"] }, file),
      ).toBeUndefined();
      const generated = generateDependabotConfig({
        files: { [file]: 'packages: ["packages/*"]', [member]: "{}" },
        policy,
      });
      expect(parseDocument(generated).getIn(["updates", 0, "directory"])).toBe(
        extension === "yaml" ? directory : memberDirectory,
      );
    }
    const file = `${prefix}pnpm-workspace.yml`;
    const pod = {
      apiVersion: "v1",
      kind: "Pod",
      spec: { containers: [{ image: "node:26" }] },
    };
    expect(containerDocumentImages(pod, file)?.ecosystem).toBe("docker");
    const generated = generateDependabotConfig({
      files: { [file]: JSON.stringify(pod) },
      policy,
    });
    expect(
      parseDocument(generated).getIn(["updates", 0, "package-ecosystem"]),
    ).toBe("docker");
    expect(parseDocument(generated).getIn(["updates", 0, "directory"])).toBe(
      directory,
    );
  }
  for (const prefix of ["vendor", "node_modules", "nested/vendor"])
    expect(toolchainInputKind(`${prefix}/pnpm-workspace.yaml`)).toBeUndefined();
});

test("cloud script discovery reads only the canonical root script", () => {
  expect(toolchainInputKind(".agents/cloud-setup.sh")).toBe("config");
  for (const file of [
    "cloud-setup.sh",
    "tools/.agents/cloud-setup.sh",
    ".agents/cloud-setup.sh.backup",
    "node_modules/.agents/cloud-setup.sh",
  ])
    expect(toolchainInputKind(file)).toBeUndefined();
});
