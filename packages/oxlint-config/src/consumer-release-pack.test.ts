import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  consumerReleasePackArguments,
  resolveConsumerReleasePack,
} from "./consumer-release-pack";

const workflow = ".github/workflows/publish.yml";
const source = readFileSync(
  new URL("../../../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);
const fixture = (setup: string, command: string) => ({
  [workflow]: `jobs:\n  pack:\n    steps:\n      - run: '${setup}'\n      - run: '${command}'\n`,
});

test("tracked release packer preserves npm flags without implicit pnpm projection", () => {
  const packer = resolveConsumerReleasePack({ [workflow]: source });
  expect(packer.manager).toBe("npm");
  expect(packer.version).toBe("11.11.1");
  expect(
    consumerReleasePackArguments({ packer, directory: "/tmp/artifacts" }),
  ).toEqual([
    "pack",
    "--ignore-scripts",
    "--pack-destination",
    "/tmp/artifacts",
  ]);
});

test("pnpm release setup supplies its exact packer and static semantic flags", () => {
  const files = {
    [workflow]: `jobs:\n  pack:\n    steps:\n      - uses: pnpm/action-setup@${"a".repeat(40)}\n        with: {version: 12.9.1}\n      - run: pnpm pack --ignore-scripts --pack-destination release-artifacts\n`,
  };
  const packer = resolveConsumerReleasePack(files);
  expect(packer.manager).toBe("pnpm");
  expect(packer.version).toBe("12.9.1");
  expect(
    consumerReleasePackArguments({ packer, directory: "/tmp/pnpm" }),
  ).toEqual(["pack", "--ignore-scripts", "--pack-destination", "/tmp/pnpm"]);
});

test("release packing requires one exact setup and one supported pack command", () => {
  for (const files of [
    {},
    fixture("npm install --global npm@11.11.1", "npm pack --ignore-scripts"),
    fixture(
      "npm install --global npm@11.11.1",
      "npm pack --pack-destination release-artifacts",
    ),
    fixture("npm install --global npm@latest", "npm pack --ignore-scripts"),
    fixture("npm install --global npm@11.11.1", "pnpm pack --ignore-scripts"),
    fixture("npm install --global npm@11.11.1", "npm pack --dry-run"),
    fixture("npm install --global npm@11.11.1", "npm pack && npm publish"),
    fixture(
      "npm install --global npm@11.11.1",
      "npm pack --pack-destination $OUTPUT",
    ),
    { [workflow]: source, ".github/workflows/second.yml": source },
    {
      [workflow]: source.replace(
        "npm pack --ignore-scripts",
        "npm pack --ignore-scripts\n            npm pack --ignore-scripts",
      ),
    },
    { [workflow]: source.replace("npm@11.11.1", "pnpm@12.9.1") },
  ])
    expect(() => resolveConsumerReleasePack(files)).toThrow();
});
