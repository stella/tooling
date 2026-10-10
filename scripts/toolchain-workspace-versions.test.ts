import { expect, test } from "bun:test";

import { syncWorkspaceToolchainPins } from "./lib/toolchain-workspace-versions";

test("owned tool release versions synchronize without adding unowned pins and converge", () => {
  for (const versions of [
    new Map([["@stll/oxlint-plugin", "0.2.1"]]),
    new Map([
      ["@stll/oxlint-plugin", "1.0.0"],
      ["unowned", "2.0.0"],
    ]),
  ]) {
    const text =
      '{"schemaVersion":1,"@stll/oxlint-plugin":"0.2.0","oxlint":"1.81.0"}\n';
    const result = syncWorkspaceToolchainPins({
      policyText: text,
      workspaceVersions: versions,
    });
    expect(result.mismatches).toHaveLength(1);
    expect(JSON.parse(result.text)).toEqual({
      schemaVersion: 1,
      "@stll/oxlint-plugin": versions.get("@stll/oxlint-plugin"),
      oxlint: "1.81.0",
    });
    expect(
      syncWorkspaceToolchainPins({
        policyText: result.text,
        workspaceVersions: versions,
      }),
    ).toEqual({ text: result.text, mismatches: [] });
  }
});

test("invalid policy data fails instead of dropping release pins", () => {
  for (const policyText of ["null", "[]", "not json"])
    expect(() =>
      syncWorkspaceToolchainPins({ policyText, workspaceVersions: new Map() }),
    ).toThrow();
});
