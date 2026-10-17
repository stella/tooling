import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";

import { checkGeneratedOutput, writeGeneratedFile } from "./generated-file";
import { ownershipHeader, removePreviousPolicy } from "./rust-policy-ownership";
import { rustWorkspaceMembers } from "./rust-workspace-members";

declare const STLL_RUST_TEMPLATES: Record<string, string>;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("unknown Rust policy input field");
};
export const parseRustPolicy = (input: unknown) => {
  if (!record(input)) throw new Error("Rust policy input must be an object");
  keys(input, ["kind", "exceptions"]);
  if (input["kind"] !== "single-crate" && input["kind"] !== "workspace")
    throw new Error("kind must be single-crate or workspace");
  const exceptions = input["exceptions"] ?? [];
  if (!Array.isArray(exceptions))
    throw new Error("exceptions must be an array");
  const parsedExceptions = exceptions.map((entry: unknown) => {
    if (!record(entry)) throw new Error("exception must be an object");
    keys(entry, ["file", "path", "value", "reason"]);
    if (
      typeof entry["file"] !== "string" ||
      !Array.isArray(entry["path"]) ||
      entry["path"].length === 0 ||
      !entry["path"].every(
        (part: unknown) => typeof part === "string" && part.length > 0,
      ) ||
      !("value" in entry) ||
      typeof entry["reason"] !== "string" ||
      entry["reason"].trim().length === 0
    )
      throw new Error(
        "exceptions require file, nonempty path, value and reason",
      );
    const path = entry["path"].map((part: unknown) => {
      if (typeof part !== "string") throw new Error("invalid exception path");
      return part;
    });
    return { file: entry["file"], path, value: entry["value"] };
  });
  return { kind: input["kind"], exceptions: parsedExceptions };
};
const merge = (
  target: Record<string, unknown>,
  policy: Record<string, unknown>,
) => {
  for (const [key, value] of Object.entries(policy)) {
    if (!record(value)) {
      target[key] = value;
      continue;
    }
    const existing = target[key];
    if (existing !== undefined && !record(existing))
      throw new Error(`policy table conflicts with value: ${key}`);
    const table = record(existing) ? existing : {};
    merge(table, value);
    target[key] = table;
  }
};
const template = async (name: string) => {
  const text =
    typeof STLL_RUST_TEMPLATES === "undefined"
      ? await readFile(
          new URL(`../../../rust/${name}`, import.meta.url),
          "utf8",
        )
      : STLL_RUST_TEMPLATES[name];
  if (text === undefined) throw new Error(`missing Rust template: ${name}`);
  return parse(text);
};
const optionalText = async (path: string) => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
};
type GenerateRustPolicyOptions = {
  root: string;
  input: unknown;
  mode: "write" | "check";
};
export const generateRustPolicy = async ({
  root,
  input,
  mode,
}: GenerateRustPolicyOptions) => {
  const policy = parseRustPolicy(input);
  const repository = await realpath(root);
  await checkGeneratedOutput(join(repository, "Cargo.toml"));
  const manifest = parse(
    await readFile(join(repository, "Cargo.toml"), "utf8"),
  );
  const members =
    policy.kind === "workspace"
      ? await rustWorkspaceMembers(repository, manifest)
      : [];
  const cargoPolicy = await template(
    policy.kind === "workspace" ? "cargo-workspace.toml" : "cargo-root.toml",
  );
  const workspace = manifest["workspace"];
  const generatedWorkspace = cargoPolicy["workspace"];
  // Cargo's resolver belongs to the project; the template supplies a default.
  if (
    record(workspace) &&
    record(generatedWorkspace) &&
    workspace["resolver"] !== undefined
  )
    generatedWorkspace["resolver"] = workspace["resolver"];
  const outputs = new Map<string, Record<string, unknown>>([
    ["Cargo.toml", cargoPolicy],
    [".cargo/config.toml", await template("cargo-config.toml")],
    ["rustfmt.toml", await template("rustfmt.toml")],
    ["clippy.toml", await template("clippy.toml")],
  ]);
  for (const member of members) {
    if (member === "Cargo.toml") {
      merge(cargoPolicy, { lints: { workspace: true } });
      continue;
    }
    outputs.set(member, { lints: { workspace: true } });
  }
  const seen = new Set<string>();
  for (const exception of policy.exceptions) {
    const signature = JSON.stringify([exception.file, exception.path]);
    if (seen.has(signature)) throw new Error("duplicate Rust policy exception");
    seen.add(signature);
    let table = outputs.get(exception.file);
    if (table === undefined)
      throw new Error("exception file is not a generated output");
    if (
      exception.path.length === 2 &&
      exception.path.at(0) === "lints" &&
      exception.path.at(1) === "workspace"
    )
      throw new Error(
        "workspace lint inheritance is structural and cannot be excepted",
      );
    const last = exception.path.at(-1);
    for (const key of exception.path.slice(0, -1)) {
      if (!Object.hasOwn(table, key))
        throw new Error("exception path must name an existing policy value");
      const nested = table[key];
      if (!record(nested))
        throw new Error("exception path must name an existing policy value");
      table = nested;
    }
    if (
      last === undefined ||
      !Object.hasOwn(table, last) ||
      record(table[last])
    )
      throw new Error("exception must replace a policy leaf");
    const previous = table[last];
    if (
      typeof previous !== typeof exception.value ||
      Array.isArray(previous) !== Array.isArray(exception.value) ||
      exception.value === null
    )
      throw new Error("exception must preserve the policy value type");
    table[last] = exception.value;
  }
  const plans = [];
  for (const [file, owned] of outputs) {
    const destination = join(repository, file);
    let parent = repository;
    for (const segment of file.split("/").slice(0, -1)) {
      parent = join(parent, segment);
      await checkGeneratedOutput(join(parent, ".stll-path-check"));
    }
    const stat = await checkGeneratedOutput(destination);
    const current = await optionalText(destination);
    if (file.endsWith("Cargo.toml") && current === undefined)
      throw new Error(`missing manifest: ${file}`);
    const document = current === undefined ? {} : parse(current);
    if (file.endsWith("Cargo.toml")) {
      const lints = document["lints"];
      const member = policy.kind === "workspace" && members.includes(file);
      if (
        member &&
        record(lints) &&
        Object.keys(lints).some((key) => key !== "workspace")
      )
        throw new Error(
          `remove local lint tables before workspace inheritance: ${file}`,
        );
      if (
        file === "Cargo.toml" &&
        policy.kind === "single-crate" &&
        record(lints) &&
        lints["workspace"] === true
      )
        throw new Error("single-crate lints cannot inherit workspace policy");
      if (
        file === "Cargo.toml" &&
        policy.kind === "workspace" &&
        !record(document["workspace"])
      )
        throw new Error("workspace kind requires a workspace manifest");
      if (
        file === "Cargo.toml" &&
        policy.kind === "single-crate" &&
        "workspace" in document
      )
        throw new Error("use workspace kind for workspace manifests");
    }
    removePreviousPolicy(file, current, document);
    merge(document, owned);
    const text = `# Generated by stll-rust-policy; edit policy input for exceptions.\n${ownershipHeader(file, owned)}${stringify(document)}`;
    plans.push({
      file,
      destination,
      text,
      current,
      mode: stat === undefined ? 0o644 : stat.mode & 0o777,
    });
  }
  const drift = plans
    .filter(({ text, current }) => text !== current)
    .map(({ file }) => file);
  if (mode === "check") return drift;
  for (const plan of plans)
    if (plan.text !== plan.current) await writeGeneratedFile(plan);
  return drift;
};
