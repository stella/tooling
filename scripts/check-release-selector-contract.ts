#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  releasePolicyRef,
  validateSelectorContract,
} from "../packages/oxlint-config/src/release-selector-contract";
import toolchain from "../packages/oxlint-config/toolchain.json";

const [command, target, ...extra] = process.argv.slice(2);
if (command === "ref" && target === undefined) {
  const source = readFileSync(
    path.join(import.meta.dir, "../.github/workflows/release-policy.yml"),
    "utf8",
  );
  console.log(`ref=${releasePolicyRef(source)}`);
} else if (command === "check" && target !== undefined && extra.length === 0) {
  const shared: unknown = await import(
    pathToFileURL(path.resolve(target)).href
  );
  const selectors =
    typeof shared === "object" &&
    shared !== null &&
    "FILE_SELECTOR_ACTIONS" in shared
      ? shared.FILE_SELECTOR_ACTIONS
      : undefined;
  validateSelectorContract({ selectors, actions: toolchain.actions });
  console.log("Shared runtime selector action pins match the toolchain policy");
} else {
  throw new Error(
    "usage: check-release-selector-contract.ts ref | check <shared-policy-source>",
  );
}
