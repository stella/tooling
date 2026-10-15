/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import policyInput from "../toolchain.json";
import { generateCloudSetup } from "./cloud-setup";
import {
  cloudSetupArtifacts,
  cloudSetupArtifactVersions,
  cloudSetupPackages,
  getCloudSetupArtifact,
  getCloudSetupPackage,
  type CloudSetupArtifactTool,
} from "./cloud-setup-artifacts";
import {
  cloudInstallCommand,
  cloudExtraTools,
  isCloudPackageTool,
  parseCloudSetup,
} from "./cloud-setup-schema";
import { parseToolchainPolicy } from "./toolchain-schema";

test("artifact catalog pins safe upstream downloads and explicit binary paths", () => {
  const checksums = new Set<string>();
  for (const release of Object.values(cloudSetupArtifactVersions).flat()) {
    for (const artifact of [release.amd64, release.arm64]) {
      const url = new URL(artifact.url);
      expect(url.protocol).toBe("https:");
      expect(["github.com", "static.rust-lang.org"]).toContain(url.hostname);
      expect(
        url.pathname
          .split("/")
          .some(
            (part) =>
              part === release.version ||
              part === `cargo-nextest-${release.version}`,
          ),
      ).toBe(true);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(checksums.has(artifact.sha256)).toBe(false);
      checksums.add(artifact.sha256);
      expect(Object.keys(artifact.binaries).length).toBeGreaterThan(0);
      for (const [name, path] of Object.entries(artifact.binaries)) {
        expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(path.split("/").at(-1)).toBe(name);
        expect(
          path.split("/").every((part) => /^[a-zA-Z0-9_.-]+$/.test(part)),
        ).toBe(true);
        expect(path.split("/").some((part) => part === "..")).toBe(false);
        if (artifact.archive === "binary") expect(path === name).toBe(true);
        else expect(url.pathname).toEndWith(".tar.gz");
      }
    }
  }
});

test("artifact lookup accepts every explicit version and rejects unsupported versions for every tool", () => {
  const tools = [
    "rustup-init",
    "cargo-nextest",
    "wasm-bindgen-cli",
    "uv",
  ] as const satisfies readonly CloudSetupArtifactTool[];
  expect(tools.map(String).sort()).toEqual(
    Object.keys(cloudSetupArtifacts).sort(),
  );
  expect(Object.keys(cloudSetupArtifactVersions).sort()).toEqual(
    Object.keys(cloudSetupArtifacts).sort(),
  );
  for (const tool of tools) {
    const releases = cloudSetupArtifactVersions[tool];
    const versions = releases.map((release) => release.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(getCloudSetupArtifact(tool, cloudSetupArtifacts[tool].version)).toBe(
      cloudSetupArtifacts[tool],
    );
    for (const release of releases)
      expect(getCloudSetupArtifact(tool, release.version)).toBe(release);
    for (const version of [
      "latest",
      "",
      ...versions.map((pin) => `v${pin}`),
      "999.0.0",
    ])
      expect(() => getCloudSetupArtifact(tool, version)).toThrow(
        `Unsupported ${tool} version ${version}; supported versions: ${versions.join(", ")}`,
      );
  }
});

test("package catalog accepts only the Ubuntu 24.04 release", () => {
  for (const [tool, release] of Object.entries(cloudSetupPackages)) {
    if (!isCloudPackageTool(tool)) throw new Error(`Unknown package ${tool}`);
    expect(getCloudSetupPackage(tool, release.version)).toBe(release);
    for (const version of ["latest", "", `v${release.version}`, "999.0"])
      expect(() => getCloudSetupPackage(tool, version)).toThrow(
        `Unsupported ${tool} version ${version}; supported versions: ${release.version}`,
      );
  }
});

test("the documented direct network hosts equal the complete generated download host set", async () => {
  const policy = parseToolchainPolicy(policyInput);
  const cloud = parseCloudSetup({
    install: cloudInstallCommand,
    services: ["postgres", "valkey"],
    envFile: ".env.cloud",
    rust: {
      components: ["clippy", "rustfmt"],
      targets: ["wasm32-unknown-unknown", "wasm32-wasip1-threads"],
    },
    tools: Object.fromEntries(
      cloudExtraTools.map((tool) => [
        tool,
        isCloudPackageTool(tool)
          ? cloudSetupPackages[tool].version
          : cloudSetupArtifacts[tool].version,
      ]),
    ),
  });
  if (cloud === undefined) throw new Error("cloud declaration absent");
  const script = generateCloudSetup({
    policy,
    cloud,
    nodeVersion: "26.10.0",
    files: {
      "Cargo.lock": `[[package]]\nname = "wasm-bindgen"\nversion = "${cloudSetupArtifacts["wasm-bindgen-cli"].version}"\n`,
    },
  });
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  const section = readme.split("### Network hosts").at(1)?.split("\n## ").at(0);
  if (section === undefined)
    throw new Error("Network hosts documentation absent");
  const documented = [...section.matchAll(/\|\s*`([^`]+)`\s*\|/g)].map(
    (match) => match[1],
  );
  const generated = [...script.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map(
    (match) => match[1],
  );
  const artifactHosts = Object.values(cloudSetupArtifactVersions)
    .flat()
    .flatMap((release) =>
      [release.amd64, release.arm64].map(({ url }) => new URL(url).hostname),
    );
  expect(new Set(documented)).toEqual(
    new Set([...generated, ...artifactHosts]),
  );
});
