#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { generateRustPolicy } from "./rust-policy";

const usage =
  "Usage: stll-rust-policy [--check] [--config <path>]\nRun from the repository root; default input: stll-rust-policy.json";
const main = async () => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args.at(0) === "--help") {
    process.stdout.write(`${usage}\n`);
    return;
  }
  let mode: "write" | "check" = "write";
  let config = "stll-rust-policy.json";
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args.at(index);
    if (arg === undefined || seen.has(arg)) throw new Error(usage);
    seen.add(arg);
    if (arg === "--check") {
      mode = "check";
      continue;
    }
    if (arg !== "--config") throw new Error(usage);
    const path = args.at(++index);
    if (path === undefined || path.startsWith("--")) throw new Error(usage);
    config = path;
  }
  const drift = await generateRustPolicy({
    root: process.cwd(),
    input: JSON.parse(await readFile(config, "utf8")),
    mode,
  });
  if (mode === "check" && drift.length > 0)
    throw new Error(
      `Rust policy drift: ${drift.join(", ")}; run stll-rust-policy`,
    );
};
main().catch((error: unknown) => {
  process.stderr.write(
    `rust-policy: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
