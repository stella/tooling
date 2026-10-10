/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import policy from "../toolchain.json";
import {
  parseToolchainPolicy,
  valkeyArchitectures,
  valkeyArtifactPackages,
} from "./toolchain-schema";

test("Node policy permits canonical major series only", () => {
  for (const node of ["26.x", "27.x"])
    expect(parseToolchainPolicy({ ...policy, node }).node).toBe(node);
  for (const node of [
    "latest",
    "^26",
    ">=26",
    "26.*",
    "26",
    "v26.x",
    "026.x",
    "9007199254740992.x",
    "26.X",
    "26.x ",
    "26.1.x",
    "26.x || 24.x",
    "24.15.0",
    "26.0.0",
    "26.1.2",
    undefined,
    null,
    26,
  ])
    expect(() => parseToolchainPolicy({ ...policy, node })).toThrow(
      /Node|node/,
    );
});

test("policy retains every declared compiler command", () => {
  expect(
    parseToolchainPolicy(policy).typescriptInstallLayouts.map(
      ({ typecheckCommand }) => typecheckCommand,
    ),
  ).toEqual(
    policy.typescriptInstallLayouts.map(
      ({ typecheckCommand }) => typecheckCommand,
    ),
  );
});

test("each layout requires a nonempty compiler command", () => {
  for (const [index] of policy.typescriptInstallLayouts.entries()) {
    for (const typecheckCommand of [undefined, "", "   ", null, 42]) {
      const mutated = {
        ...policy,
        typescriptInstallLayouts: [
          ...policy.typescriptInstallLayouts.slice(0, index),
          { ...policy.typescriptInstallLayouts.at(index), typecheckCommand },
          ...policy.typescriptInstallLayouts.slice(index + 1),
        ],
      };
      expect(() => parseToolchainPolicy(mutated)).toThrow("typecheckCommand");
    }
  }
});

test("service policy requires a canonical PostgreSQL major and exact stable Valkey release", () => {
  expect(parseToolchainPolicy(policy).postgres).toBe(policy.postgres);
  expect(parseToolchainPolicy(policy).valkey).toBe(policy.valkey);
  for (const postgres of ["1", "18", "19"])
    expect(parseToolchainPolicy({ ...policy, postgres }).postgres).toBe(
      postgres,
    );
  for (const postgres of [
    undefined,
    null,
    false,
    18,
    "",
    "0",
    "018",
    "18.0",
    "18.0.0",
    "18.x",
    "^18",
    "latest",
    "18 ",
    "9007199254740992",
  ])
    expect(() => parseToolchainPolicy({ ...policy, postgres })).toThrow(
      /PostgreSQL|postgres/,
    );
  for (const valkey of ["9.1.1", "10.0.0"])
    expect(
      parseToolchainPolicy({
        ...policy,
        valkey,
        valkeyArtifacts: retargetValkeyArtifacts(valkey),
      }).valkey,
    ).toBe(valkey);
  for (const valkey of [
    undefined,
    null,
    false,
    9,
    "",
    "9",
    "9.1",
    "9.1.x",
    "^9.1.1",
    "latest",
    "v9.1.1",
    "09.1.1",
    "9.1.1 ",
    "9.1.1-rc.1",
    "9.1.1+build",
    "9007199254740992.1.1",
  ])
    expect(() => parseToolchainPolicy({ ...policy, valkey })).toThrow(
      /Valkey|valkey/,
    );
});

const retargetValkeyArtifacts = (version: string) =>
  Object.fromEntries(
    valkeyArchitectures.map((architecture) => [
      architecture,
      Object.fromEntries(
        Object.entries(policy.valkeyArtifacts[architecture]).map(
          ([kind, artifact]) => [
            kind,
            {
              ...artifact,
              url: artifact.url
                .replace(
                  `valkey-${policy.valkey.split(".").slice(0, 2).join(".")}/`,
                  `valkey-${version.split(".").slice(0, 2).join(".")}/`,
                )
                .replace(`_${policy.valkey}-1.noble_`, `_${version}-1.noble_`),
            },
          ],
        ),
      ),
    ]),
  );

test("Valkey artifact policy is total, closed and bound to its declared release", () => {
  expect(parseToolchainPolicy(policy).valkeyArtifacts).toEqual(
    policy.valkeyArtifacts,
  );
  for (const valkeyArtifacts of [
    undefined,
    null,
    [],
    {},
    { ...policy.valkeyArtifacts, extra: {} },
  ])
    expect(() => parseToolchainPolicy({ ...policy, valkeyArtifacts })).toThrow(
      "valkeyArtifacts",
    );
  for (const architecture of valkeyArchitectures) {
    const missing = Object.fromEntries(
      Object.entries(policy.valkeyArtifacts).filter(
        ([key]) => key !== architecture,
      ),
    );
    expect(() =>
      parseToolchainPolicy({ ...policy, valkeyArtifacts: missing }),
    ).toThrow("valkeyArtifacts");
    for (const packages of [
      null,
      [],
      {},
      { ...policy.valkeyArtifacts[architecture], extra: {} },
    ])
      expect(() =>
        parseToolchainPolicy({
          ...policy,
          valkeyArtifacts: {
            ...policy.valkeyArtifacts,
            [architecture]: packages,
          },
        }),
      ).toThrow("valkeyArtifacts");
    for (const [kind, artifact] of Object.entries(
      policy.valkeyArtifacts[architecture],
    )) {
      expect(Object.hasOwn(valkeyArtifactPackages, kind)).toBe(true);
      const missingPackage = Object.fromEntries(
        Object.entries(policy.valkeyArtifacts[architecture]).filter(
          ([key]) => key !== kind,
        ),
      );
      expect(() =>
        parseToolchainPolicy({
          ...policy,
          valkeyArtifacts: {
            ...policy.valkeyArtifacts,
            [architecture]: missingPackage,
          },
        }),
      ).toThrow("valkeyArtifacts");
      const check = (replacement: unknown) =>
        parseToolchainPolicy({
          ...policy,
          valkeyArtifacts: {
            ...policy.valkeyArtifacts,
            [architecture]: {
              ...policy.valkeyArtifacts[architecture],
              [kind]: replacement,
            },
          },
        });
      for (const sha256 of [
        undefined,
        null,
        123,
        "",
        artifact.sha256.toUpperCase(),
        "g".repeat(64),
        "a".repeat(63),
        "a".repeat(65),
      ])
        expect(() => check({ ...artifact, sha256 })).toThrow("SHA256");
      for (const url of [
        undefined,
        null,
        123,
        artifact.url.replace(policy.valkey, "9.1.2"),
        artifact.url.replace("download.valkey.io", "example.com"),
        artifact.url.replace("ubuntu2404", "ubuntu2204"),
        artifact.url.replace(`/${architecture}/`, "/../"),
        artifact.url + "?redirect=other",
        artifact.url + "#fragment",
        artifact.url.replace("https://", "http://"),
        artifact.url.replace(
          `valkey-${kind}_`,
          kind === "server" ? "valkey-tools_" : "valkey-server_",
        ),
        artifact.url.replace(
          `_${architecture}.deb`,
          architecture === "amd64" ? "_arm64.deb" : "_amd64.deb",
        ),
      ])
        expect(() => check({ ...artifact, url })).toThrow("URL");
      for (const replacement of [null, [], {}, { ...artifact, extra: true }])
        expect(() => check(replacement)).toThrow("valkeyArtifacts");
    }
  }
  expect(() => parseToolchainPolicy({ ...policy, valkey: "9.1.2" })).toThrow(
    "valkeyArtifacts URL",
  );
});
