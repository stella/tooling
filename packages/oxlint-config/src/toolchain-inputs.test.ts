/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";

import toolchain from "../toolchain.json";
import { containerDocumentImages } from "./toolchain-container-inputs";
import {
  checkDependabot,
  generateDependabotConfig,
} from "./toolchain-dependabot";
import { readToolchainInputs } from "./toolchain-guard";
import {
  dependabotManifestEcosystem,
  dependabotManifestEcosystems,
  githubAutomationFileKind,
  isDependabotGithubActionsPath,
  isDockerDefinitionPath,
  pythonDependencyManifestKind,
  isPythonDependencyManifest,
  javascriptDependencyLockfiles,
  toolchainInputKind,
} from "./toolchain-inputs";
import { parseToolchainPolicy } from "./toolchain-schema";

test("both input readers exclude dependency trees for every accepted input kind", () => {
  const inputs = [
    ...Object.keys(dependabotManifestEcosystems),
    "package.json",
    "consumer-compat.json",
    ...javascriptDependencyLockfiles,
    "uv.lock",
    "pyproject.toml",
    "scripts/rust.sh",
    "scripts/ci-service-images.json",
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
}, 15_000);

test("every declared dependency ecosystem enters tracked snapshots as presence", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stll-dependency-inputs-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const expected: Record<string, string> = {};
    for (const [name, ecosystem] of Object.entries(
      dependabotManifestEcosystems,
    )) {
      for (const prefix of ["", "nested/"]) {
        const file = `${prefix}${name}`;
        expect(dependabotManifestEcosystem(file)).toBe(ecosystem);
        expect(toolchainInputKind(file)).toBe("presence");
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(
          path.join(root, file),
          "dependency graph bytes are not read",
        );
        expected[file] = "";
      }
      for (const prefix of ["vendor/", "nested/node_modules/"]) {
        const file = `${prefix}${name}`;
        expect(dependabotManifestEcosystem(file)).toBeUndefined();
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), "ignored dependency graph");
      }
    }
    execFileSync("git", ["add", "-f", "."], { cwd: root });
    const snapshot = readToolchainInputs(root);
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.files).toEqual(expected);
    const policy = parseToolchainPolicy(toolchain).dependabot;
    const generated = generateDependabotConfig({
      files: snapshot.files,
      policy,
    });
    expect(
      checkDependabot({
        files: { ...snapshot.files, ".github/dependabot.yml": generated },
        policy,
      }),
    ).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("JavaScript installation lockfiles are tracked as presence without reading dependency graphs", () => {
  for (const file of javascriptDependencyLockfiles) {
    expect(toolchainInputKind(file)).toBe("presence");
    expect(toolchainInputKind(`project/${file}`)).toBe("presence");
  }
  for (const file of ["unrelated.lock", "pnpm-lock.yml", "package-lock.txt"])
    expect(toolchainInputKind(file)).not.toBe("presence");
}, 15_000);

test("presence snapshots omit deleted tracked declarations across every dependency ecosystem", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stll-deleted-inputs-"));
  const paths = [
    ...Object.keys(dependabotManifestEcosystems),
    ...javascriptDependencyLockfiles,
    "Pipfile.lock",
    "uv.lock",
  ].flatMap((name) => [name, `nested/${name}`]);
  try {
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(path.join(root, "nested"));
    for (const file of paths) {
      expect(toolchainInputKind(file)).toBe("presence");
      writeFileSync(path.join(root, file), "presence only");
    }
    execFileSync("git", ["add", "."], { cwd: root });
    expect(Object.keys(readToolchainInputs(root).files).sort()).toEqual(
      paths.toSorted(),
    );
    for (const file of paths) rmSync(path.join(root, file));
    const deleted = readToolchainInputs(root);
    expect(deleted.trackedFiles).toEqual(new Set(paths));
    expect(deleted.files).toEqual({});
    expect(deleted.diagnostics).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("non-absence presence probe failures remain configuration diagnostics", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stll-input-failure-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(path.join(root, "nested"));
    writeFileSync(path.join(root, "nested/Gemfile"), "presence only");
    execFileSync("git", ["add", "."], { cwd: root });
    rmSync(path.join(root, "nested"), { recursive: true });
    writeFileSync(path.join(root, "nested"), "not a directory");
    expect(readToolchainInputs(root).diagnostics).toEqual([
      {
        rule: "configuration",
        path: "nested/Gemfile",
        line: 1,
        message: "cannot read tracked configuration file",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

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
}, 15_000);

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
}, 15_000);

test("Pipenv lockfiles provide ecosystem presence without dependency graph reads", () => {
  expect(pythonDependencyManifestKind("python/Pipfile")).toBe("pipfile");
  expect(toolchainInputKind("python/Pipfile")).toBe("config");
  expect(pythonDependencyManifestKind("python/Pipfile.lock")).toBe(
    "pipfile-lock",
  );
  expect(toolchainInputKind("python/Pipfile.lock")).toBe("presence");
}, 15_000);

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
}, 15_000);

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
}, 15_000);

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
}, 15_000);

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
      const files: Record<string, string> = {
        [file]: 'packages: ["packages/*"]',
        [member]: JSON.stringify({ name: "workspace-member", private: true }),
      };
      if (extension === "yaml") {
        files[`${prefix}package.json`] = JSON.stringify({
          name: "workspace-root",
          private: true,
        });
        files[`${prefix}bun.lock`] = "";
      } else {
        files[`${prefix}packages/app/bun.lock`] = "";
      }
      const generated = generateDependabotConfig({
        files,
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
}, 15_000);

test("shell discovery includes cloud setup scripts but excludes backups and installed dependencies", () => {
  for (const file of [
    ".agents/cloud-setup.sh",
    "cloud-setup.sh",
    "tools/.agents/cloud-setup.sh",
  ])
    expect(toolchainInputKind(file)).toBe("config");
  for (const file of [
    ".agents/cloud-setup.sh.backup",
    "node_modules/.agents/cloud-setup.sh",
  ])
    expect(toolchainInputKind(file)).toBeUndefined();
}, 15_000);

test("shell shebangs identify extensionless executable inputs without selecting ordinary text", () => {
  for (const shebang of [
    "#!/bin/sh",
    "#!/usr/bin/bash",
    "#!/usr/bin/env bash",
    "#!/usr/bin/env -S bash -eu",
  ]) {
    expect(
      toolchainInputKind("scripts/check", shebang + "\ncargo +stable test"),
    ).toBe("config");
    expect(toolchainInputKind("vendor/check", shebang)).toBeUndefined();
    expect(toolchainInputKind("node_modules/check", shebang)).toBeUndefined();
  }
  expect(
    toolchainInputKind("scripts/check", "#!/usr/bin/env python3"),
  ).toBeUndefined();
  expect(toolchainInputKind("README", "cargo +stable test")).toBeUndefined();
}, 15_000);

test("cloud setup reads committed Claude settings and Cargo lock dependency versions", () => {
  expect(toolchainInputKind(".claude/settings.json")).toBe("config");
  expect(toolchainInputKind(".claude/settings.local.json")).toBeUndefined();
  expect(toolchainInputKind("Cargo.lock")).toBe("config");
  expect(toolchainInputKind("crates/project/Cargo.lock")).toBeUndefined();
  expect(toolchainInputKind("vendor/project/Cargo.lock")).toBeUndefined();
}, 15_000);
