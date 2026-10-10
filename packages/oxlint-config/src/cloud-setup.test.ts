/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import policyInput from "../toolchain.json";
import { cloudEnvironmentMarker, generateCloudSetup } from "./cloud-setup";
import {
  cloudInstallCommand,
  cloudServices,
  parseCloudSetup,
} from "./cloud-setup-schema";
import { parseToolchainPolicy } from "./toolchain-schema";

const policy = parseToolchainPolicy(policyInput);
const generate = (input: unknown, nodeVersion = "26.10.0") => {
  const cloud = parseCloudSetup(input);
  if (cloud === undefined) throw new Error("Missing cloud declaration");
  return generateCloudSetup({ policy, cloud, nodeVersion });
};
const declaration = {
  services: [],
  install: cloudInstallCommand,
  envFile: ".env.cloud",
};

test("generated script rejects missing or unknown modes before platform checks", () => {
  const generated = generate(declaration);
  for (const args of [[], ["unknown"], ["--help"], ["install", "start"]]) {
    const result = Bun.spawnSync(["bash", "-s", "--", ...args], {
      stdin: Buffer.from(generated),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(
      "Usage: cloud-setup.sh install|start\n",
    );
  }
});

const environmentParts = (generated: string) => {
  const assignment = /^ENV_FILE=.*$/m.exec(generated)?.at(0);
  const marker = /^ENV_MARKER=.*$/m.exec(generated)?.at(0);
  const start = generated.indexOf("\nvalidate_environment() {");
  const end = generated.indexOf('\nif [[ "$MODE" == install ]]; then', start);
  if (
    assignment === undefined ||
    marker === undefined ||
    start < 0 ||
    end <= start
  )
    throw new Error(
      "Missing emitted environment assignment or function boundary",
    );
  return { assignment, marker, functions: generated.slice(start, end) };
};

const withRepository = (run: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "cloud-environment-test-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const environmentRun = ({
  root,
  generated,
  command,
}: {
  root: string;
  generated: string;
  command: string;
}) => {
  const { assignment, marker, functions } = environmentParts(generated);
  return Bun.spawnSync(
    [
      "bash",
      "-eu",
      "-c",
      `fail() { echo "$*" >&2; exit 1; }
OUTPUT_UID="$(id -u)"
OUTPUT_GID="$(id -g)"
DATABASE_URL='postgresql://local-test@127.0.0.1:55432/test'
REDIS_URL='redis://local-test@127.0.0.1:56379/0'
${assignment}
${marker}
${functions}
${command}`,
    ],
    { cwd: root, env: { ...process.env, REPO_ROOT: root } },
  );
};

test("all service subsets generate deterministic valid Bash regardless of declaration order", () => {
  for (let mask = 0; mask < 2 ** cloudServices.length; mask += 1) {
    const services = cloudServices.filter(
      (_, index) => (mask & (1 << index)) !== 0,
    );
    const generated = generate({ ...declaration, services });
    expect(generate({ ...declaration, services })).toBe(generated);
    expect(generate({ ...declaration, services: services.toReversed() })).toBe(
      generated,
    );
    const syntax = Bun.spawnSync(["bash", "-n"], {
      stdin: Buffer.from(generated),
    });
    expect(syntax.exitCode).toBe(0);
    expect(syntax.stderr.toString()).toBe("");
    for (const service of cloudServices) {
      const marker = service === "postgres" ? "pg_ctl" : "valkey-server";
      expect(generated.includes(marker)).toBe(services.includes(service));
    }
  }
});

test("cloud generation rejects every nonexact or out-of-series Node selector", () => {
  expect(generate(declaration, "26.10.0\n")).toContain(
    "NODE_VERSION='26.10.0'",
  );
  for (const nodeVersion of [
    "",
    "26",
    "26.x",
    "26.10",
    "v26.10.0",
    "026.10.0",
    "26.10.0-rc.1",
    "26.10.0+meta",
    "24.15.0",
    "latest",
    "^26.10.0",
    "26.10.0; true",
    "26.10.0\n26.11.0",
  ])
    expect(() => generate(declaration, nodeVersion)).toThrow(
      "exact .node-version",
    );
});

test("shell quoting preserves adversarial environment names with single-pass template replacement", () => {
  withRepository((root) => {
    for (const envFile of [
      ".env'quote",
      '.env"quote',
      ".env$(touch injected)",
      ".env`touch injected`",
      ".env$HOME",
      ".env@SERVICE_INSTALL@",
      ".env'$(touch injected)`touch injected`@SERVICE_START@",
    ]) {
      const generated = generate({ ...declaration, envFile });
      const syntax = Bun.spawnSync(["bash", "-n"], {
        stdin: Buffer.from(generated),
      });
      expect(syntax.exitCode).toBe(0);
      const result = environmentRun({
        root,
        generated,
        command: 'printf "%s" "$ENV_FILE"',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(envFile);
      expect(existsSync(join(root, "injected"))).toBe(false);
    }
  });
});

test("actual emitted environment functions write owned files idempotently with private permissions", () => {
  withRepository((root) => {
    mkdirSync(join(root, "config"));
    const generated = generate({
      ...declaration,
      envFile: "config/.env.cloud",
    });
    const file = join(root, "config/.env.cloud");
    const first = environmentRun({
      root,
      generated,
      command: "write_environment",
    });
    expect(first.exitCode).toBe(0);
    const content = readFileSync(file, "utf8");
    expect(content).toBe(
      `${cloudEnvironmentMarker}\nNODE_ENV=test\nDATABASE_URL=postgresql://local-test@127.0.0.1:55432/test\nREDIS_URL=redis://local-test@127.0.0.1:56379/0\n`,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(
      environmentRun({ root, generated, command: "write_environment" })
        .exitCode,
    ).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(content);
  });
});

test("actual emitted environment validation refuses unowned files, symlinks and missing parents", () => {
  withRepository((root) => {
    const outside = mkdtempSync(join(tmpdir(), "cloud-environment-outside-"));
    try {
      const sentinel = join(outside, "sentinel");
      writeFileSync(sentinel, "unchanged\n");
      writeFileSync(join(root, ".env.unowned"), "unowned\n");
      symlinkSync(sentinel, join(root, ".env.link"));
      symlinkSync(outside, join(root, "linked"), "dir");
      mkdirSync(join(root, ".env.directory"));
      for (const envFile of [
        ".env.unowned",
        ".env.link",
        "linked/sentinel",
        "missing/.env",
        ".env.directory",
      ]) {
        const generated = generate({ ...declaration, envFile });
        const result = environmentRun({
          root,
          generated,
          command: "write_environment",
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toMatch(
          /unowned|symbolic links|missing|regular file/,
        );
      }
      expect(readFileSync(sentinel, "utf8")).toBe("unchanged\n");
      expect(readFileSync(join(root, ".env.unowned"), "utf8")).toBe(
        "unowned\n",
      );
      expect(existsSync(join(root, "missing"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
