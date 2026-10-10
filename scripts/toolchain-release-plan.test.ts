import { expect, test } from "bun:test";

import manifest from "../package.json";
import { toolchainReleaseChangeset } from "./lib/toolchain-release-plan";

const policyText = '{"@stll/oxlint-plugin":"0.2.0","oxlint":"1.81.0"}';
type PlannedReleaseOptions = {
  name: string;
  newVersion: string;
  type?: string;
};
const release = ({
  name,
  newVersion,
  type = "patch",
}: PlannedReleaseOptions) => ({ name, newVersion, type });
const changesetFor = (releases: unknown[]) =>
  toolchainReleaseChangeset({ policyText, releasePlan: { releases } });

test("every owned pin release also releases its policy container", () => {
  for (const type of ["patch", "minor", "major"]) {
    const planned = release({
      name: "@stll/oxlint-plugin",
      newVersion: "1.0.0",
      type,
    });
    const changeset = changesetFor([planned]);
    expect(changeset).toContain('"@stll/oxlint-config": patch');
    expect(
      changesetFor([
        planned,
        release({ name: "@stll/oxlint-config", newVersion: "0.8.1" }),
      ]),
    ).toBeUndefined();
    expect(
      changesetFor([
        planned,
        release({
          name: "@stll/oxlint-config",
          newVersion: "0.8.0",
          type: "none",
        }),
      ]),
    ).toBe(changeset);
  }
  for (const releases of [
    [],
    [release({ name: "unowned", newVersion: "1.0.0" })],
    [release({ name: "@stll/oxlint-plugin", newVersion: "0.2.0" })],
    [
      release({
        name: "@stll/oxlint-plugin",
        newVersion: "0.2.1",
        type: "none",
      }),
    ],
  ])
    expect(changesetFor(releases)).toBeUndefined();
});

test("release preparation runs before versioning and policy synchronization", () => {
  const commands = manifest.scripts["changeset:version"].split(" && ");
  expect(commands.slice(0, 3)).toEqual([
    "bun scripts/ensure-toolchain-release.ts",
    "changeset version",
    "bun scripts/check-lockfile-workspace-versions.ts --write",
  ]);
});

test("invalid release plans fail before versioning", () => {
  for (const releasePlan of [
    null,
    {},
    { releases: [null] },
    { releases: [{ name: "tool" }] },
  ])
    expect(() =>
      toolchainReleaseChangeset({ policyText, releasePlan }),
    ).toThrow();
});
