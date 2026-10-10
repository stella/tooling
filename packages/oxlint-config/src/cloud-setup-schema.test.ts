/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import {
  cloudInstallCommand,
  cloudServices,
  parseCloudSetup,
} from "./cloud-setup-schema";

const declaration = {
  services: [],
  install: cloudInstallCommand,
  envFile: ".env",
};

test("undeclared cloud setup remains absent", () => {
  expect(parseCloudSetup(undefined)).toBeUndefined();
});

test("every service subset, including no services, round-trips without assuming others", () => {
  for (let mask = 0; mask < 2 ** cloudServices.length; mask += 1) {
    const services = cloudServices.filter(
      (_, index) => (mask & (1 << index)) !== 0,
    );
    for (const ordered of [services, services.toReversed()]) {
      expect(parseCloudSetup({ ...declaration, services: ordered })).toEqual({
        services: ordered,
        install: cloudInstallCommand,
        envFile: declaration.envFile,
      });
    }
  }
});

test("nonobject declarations and unsupported keys fail closed", () => {
  for (const input of [null, false, 0, "cloud", [], [declaration]])
    expect(() => parseCloudSetup(input)).toThrow("cloud must be an object");
  for (const key of ["node", "env", "lifecycle", "command", "extra"])
    expect(() => parseCloudSetup({ ...declaration, [key]: "value" })).toThrow(
      `unsupported cloud key: ${key}`,
    );
});

test("services require an explicit array of distinct supported names", () => {
  expect(() => parseCloudSetup({ install: cloudInstallCommand })).toThrow(
    "cloud.services",
  );
  for (const services of [null, false, 1, "postgres", {}])
    expect(() => parseCloudSetup({ ...declaration, services })).toThrow(
      "cloud.services",
    );
  for (const service of [
    "mysql",
    "Postgres",
    " postgres",
    "redis",
    "valkey ",
    "",
    null,
    undefined,
    1,
    true,
    {},
    [],
  ]) {
    for (const services of [[service], ["postgres", service]])
      expect(() => parseCloudSetup({ ...declaration, services })).toThrow(
        "unsupported service",
      );
  }
  const sparse = ["postgres"];
  sparse.length += 1;
  expect(() => parseCloudSetup({ ...declaration, services: sparse })).toThrow(
    "unsupported service",
  );
  for (const service of cloudServices)
    expect(() =>
      parseCloudSetup({ ...declaration, services: [service, service] }),
    ).toThrow("duplicate service");
});

test("only the exact frozen Bun install command is accepted", () => {
  expect(() => parseCloudSetup({ services: [] })).toThrow("cloud.install");
  for (const install of [
    undefined,
    null,
    false,
    1,
    [],
    {},
    "",
    "bun install",
    "bun install --frozen-lockfile ",
    " bun install --frozen-lockfile",
    "bun install --frozen-lockfile\n",
    "bun install --frozen-lockfile && echo done",
    "npm ci",
  ])
    expect(() => parseCloudSetup({ ...declaration, install })).toThrow(
      "cloud.install",
    );
});

test("environment files require canonical safe repository-relative paths", () => {
  for (const envFile of [
    ".env",
    ".env.cloud",
    "config/.env",
    ".agents/cloud.env",
  ])
    expect(parseCloudSetup({ ...declaration, envFile })?.envFile).toBe(envFile);
  expect(() =>
    parseCloudSetup({ services: [], install: cloudInstallCommand }),
  ).toThrow("cloud.envFile");
  for (const envFile of [
    undefined,
    null,
    false,
    0,
    [],
    {},
    "",
    "/tmp/.env",
    "C:/.env",
    "C:.env",
    "\\server\\.env",
    "config\\.env",
    ".",
    "..",
    "./.env",
    "../.env",
    "config/../.env",
    "config/./.env",
    "config//.env",
    "config/",
    ".env\n",
    ".env\r",
    ".env\0",
    ".env\u007f",
    ".env\u0085",
  ])
    expect(() => parseCloudSetup({ ...declaration, envFile })).toThrow(
      "cloud.envFile",
    );
});
