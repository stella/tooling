/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import {
  cloudInstallCommand,
  cloudInstallCommands,
  cloudServices,
  parseCloudSetup,
} from "./cloud-setup-schema";

const declaration = {
  services: ["postgres"],
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
      const selected = {
        services: ordered,
        install: cloudInstallCommand,
      } as const;
      if (ordered.length === 0) {
        expect(parseCloudSetup(selected)).toEqual(selected);
        expect(parseCloudSetup(selected)).not.toHaveProperty("envFile");
      } else {
        const configured = { ...selected, envFile: declaration.envFile };
        expect(parseCloudSetup(configured)).toEqual(configured);
      }
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

test("omitted services are install-only and env files require actual services", () => {
  const installOnly = { install: cloudInstallCommand } as const;
  expect(parseCloudSetup(installOnly)).toEqual({
    ...installOnly,
    services: [],
  });
  expect(parseCloudSetup(installOnly)).not.toHaveProperty("envFile");
  for (const envFile of [".env", undefined, null, false, ""])
    for (const configuration of [installOnly, { ...installOnly, services: [] }])
      expect(() => parseCloudSetup({ ...configuration, envFile })).toThrow(
        "not allowed without services",
      );
});

test("provided services require an array of distinct supported names", () => {
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
    parseCloudSetup({ services: ["postgres"], install: cloudInstallCommand }),
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

test("install accepts the frozen command with or without lifecycle scripts and nothing else", () => {
  for (const install of cloudInstallCommands) {
    const parsed = parseCloudSetup({ ...declaration, install });
    expect(parsed?.install).toBe(install);
    expect(parsed?.services).toEqual(["postgres"]);
    expect(parsed?.envFile).toBe(declaration.envFile);
  }
  for (const install of [
    "bun install",
    "bun install --ignore-scripts",
    "bun install --ignore-scripts --frozen-lockfile",
    `${cloudInstallCommand} --ignore-scripts --production`,
    `${cloudInstallCommand}  --ignore-scripts`,
    `${cloudInstallCommand} --ignore-scripts `,
    undefined,
    null,
    1,
  ])
    expect(() => parseCloudSetup({ ...declaration, install })).toThrow(
      "cloud.install must be exactly one of",
    );
});

test("prepare names one package script with a bounded time", () => {
  const install = cloudInstallCommand;
  expect(
    parseCloudSetup({ install, prepare: { script: "generate:cloud", seconds: 900 } }),
  ).toEqual({
    services: [],
    install,
    prepare: { script: "generate:cloud", seconds: 900 },
  });
  for (const [prepare, message] of [
    [null, "cloud.prepare must be an object"],
    [[], "cloud.prepare must be an object"],
    [{ script: "a", seconds: 1, extra: 1 }, "unsupported cloud.prepare key: extra"],
    [{ seconds: 10 }, "cloud.prepare.script must name a package script"],
    [{ script: "", seconds: 10 }, "cloud.prepare.script must name a package script"],
    [{ script: "a b", seconds: 10 }, "cloud.prepare.script must name a package script"],
    [{ script: "a;rm", seconds: 10 }, "cloud.prepare.script must name a package script"],
    [{ script: "-a", seconds: 10 }, "cloud.prepare.script must name a package script"],
    [{ script: "a" }, "cloud.prepare.seconds must be an integer from 1 to 900"],
    [{ script: "a", seconds: 0 }, "cloud.prepare.seconds must be an integer from 1 to 900"],
    [{ script: "a", seconds: 901 }, "cloud.prepare.seconds must be an integer from 1 to 900"],
    [{ script: "a", seconds: 1.5 }, "cloud.prepare.seconds must be an integer from 1 to 900"],
    [{ script: "a", seconds: "10" }, "cloud.prepare.seconds must be an integer from 1 to 900"],
  ] as const) {
    expect(() => parseCloudSetup({ install, prepare })).toThrow(message);
  }
});
