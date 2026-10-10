/// <reference types="bun-types" />
import { expect, test } from "bun:test";
import { parseDocument } from "yaml";

import {
  containerDocumentImages,
  isComposeDefinitionPath,
  isKubernetesDefinitionPath,
  kubernetesPodSpecPaths,
} from "./toolchain-container-inputs";
import { toolchainInputKind } from "./toolchain-inputs";

test("Compose filenames and semantic services use the same discovered class", () => {
  for (const file of [
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.override.yml",
    "compose-prod.yaml",
    "COMPOSE.PROD.YAML",
    ".compose.yaml",
  ]) {
    expect(isComposeDefinitionPath(file)).toBe(true);
    expect(toolchainInputKind(file)).toBe("config");
    expect(
      containerDocumentImages(
        {
          services: {
            app: { image: "node:26" },
            example: { labels: { image: "not-an-image" } },
          },
        },
        file,
      ),
    ).toEqual({
      ecosystem: "docker-compose",
      images: [{ image: "node:26", path: ["services", "app", "image"] }],
    });
  }
  expect(
    containerDocumentImages({ image: "node:latest" }, "compose.yaml"),
  ).toBeUndefined();
  expect(
    containerDocumentImages(
      { services: { app: { image: "node:latest" } } },
      "notes.yaml",
    ),
  ).toBeUndefined();
});

test("Compose filename tokens must span the complete basename", () => {
  for (const file of [
    "decompose.yaml",
    "mycompose.yml",
    "compose.yaml.backup",
    "scripts/generate-compose.yaml",
    "docs/docker-compose.yml.md",
  ]) {
    expect(isComposeDefinitionPath(file)).toBe(false);
    expect(
      containerDocumentImages(
        { services: { app: { image: "node:latest" } } },
        file,
      ),
    ).toBeUndefined();
  }
});

test("Kubernetes image enumeration requires resource and pod-spec shape", () => {
  const containers = {
    containers: [{ image: "node:26" }],
    initContainers: [{ image: "python:3.13" }],
    ephemeralContainers: [{ image: "oven/bun:1.4.3" }],
    image: "ignored",
  };
  for (const [kind, specPath] of Object.entries(kubernetesPodSpecPaths)) {
    const resource: Record<string, unknown> = { apiVersion: "v1", kind };
    let target = resource;
    for (const key of specPath.slice(0, -1)) {
      const child: Record<string, unknown> = {};
      target[key] = child;
      target = child;
    }
    const key = specPath.at(-1);
    if (key === undefined) throw new Error("Pod spec path must not be empty");
    target[key] = containers;
    const direct = containerDocumentImages(resource, "deploy/resource.yaml");
    expect(direct?.ecosystem).toBe("docker");
    expect(direct?.images.map(({ image }) => image)).toEqual([
      "node:26",
      "python:3.13",
      "oven/bun:1.4.3",
    ]);
    const list = containerDocumentImages(
      { apiVersion: "v1", kind: "List", items: [resource] },
      "deploy/resource.yaml",
    );
    expect(list?.images.map(({ path }) => path.slice(0, 2))).toEqual([
      ["items", 0],
      ["items", 0],
      ["items", 0],
    ]);
  }
  for (const value of [
    { image: "node:latest" },
    { services: { app: { image: "node:latest" } } },
    { kind: "Pod", spec: containers },
    { apiVersion: "v1", kind: "ConfigMap", data: { image: "node:latest" } },
  ])
    expect(containerDocumentImages(value, "notes.yaml")).toBeUndefined();
  expect(isKubernetesDefinitionPath("deploy/RESOURCE.YAML")).toBe(true);
  expect(toolchainInputKind("deploy/RESOURCE.YAML")).toBe("config");
});

test("aliased Kubernetes Lists cannot recurse indefinitely or conceal later pod images", () => {
  const parsed: unknown = parseDocument(
    "apiVersion: v1\nkind: List\nitems:\n  - &nested\n    apiVersion: v1\n    kind: List\n    items: [*nested]\n  - apiVersion: v1\n    kind: Pod\n    spec: {containers: [{image: 'node:26'}]}\n",
  ).toJS({ maxAliasCount: 100 });
  expect(
    containerDocumentImages(parsed, "resource.yaml")?.images.map(
      ({ image }) => image,
    ),
  ).toEqual(["node:26"]);
});
