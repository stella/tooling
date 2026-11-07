import { expect, test } from "bun:test";
import { parseDocument } from "yaml";

import policyInput from "../toolchain.json";
import {
  generateDependabotConfig,
  parseDependabotInput,
  parseToolchainPolicy,
  supportedDependabotEcosystems,
} from "./dependabot";

const policy = parseToolchainPolicy(policyInput).dependabot;

test.each(supportedDependabotEcosystems)(
  "accepts and renders the documented ecosystem %s",
  (ecosystem) => {
    const updates = parseDependabotInput({
      updates: [{ ecosystem, directories: ["/"] }],
    });
    const output = generateDependabotConfig({ files: {}, policy, updates });
    const rendered: unknown = parseDocument(output).toJS();
    expect(rendered).toEqual(
      expect.objectContaining({
        updates: [
          expect.objectContaining({
            "package-ecosystem": ecosystem,
            directory: "/",
          }),
        ],
      }),
    );
  },
);

test.each([
  "githb-actions",
  "unknown-ecosystem",
  "poetry",
  "pnpm",
  "GitHub-Actions",
  "",
])("rejects unsupported ecosystem %s before generation", (ecosystem) => {
  expect(() =>
    parseDependabotInput({ updates: [{ ecosystem, directories: ["/"] }] }),
  ).toThrow(`unsupported Dependabot ecosystem: ${ecosystem}`);
});
