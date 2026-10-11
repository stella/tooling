import { parseDocument } from "yaml";

import { canonicalDockerRuntime, rustImageVersion } from "./toolchain-images";
import { githubAutomationFileKind, isShellScript } from "./toolchain-inputs";
import { decodeShellWord, shellCommandSegments } from "./toolchain-packages";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type RustException = {
  pin: string;
  reason: string;
  tracking: string;
  expires: string;
};

/** Exceptions authorize one immutable release, never a channel or an entire rule. */
export const parseRustExceptions = (
  input: unknown,
  today = new Date().toISOString().slice(0, 10),
): RustException[] => {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("rustExceptions must be an array");
  const pins = new Set<string>();
  return input.map((entry: unknown) => {
    if (
      !record(entry) ||
      Object.keys(entry).length !== 4 ||
      Object.keys(entry).some(
        (key) => !["pin", "reason", "tracking", "expires"].includes(key),
      ) ||
      typeof entry["pin"] !== "string" ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(entry["pin"]) ||
      typeof entry["reason"] !== "string" ||
      entry["reason"].trim() === "" ||
      typeof entry["tracking"] !== "string" ||
      !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/[1-9]\d*$/.test(
        entry["tracking"],
      ) ||
      typeof entry["expires"] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry["expires"]) ||
      !Number.isFinite(Date.parse(entry["expires"])) ||
      new Date(entry["expires"]).toISOString().slice(0, 10) !==
        entry["expires"] ||
      entry["expires"] <= today ||
      pins.has(entry["pin"])
    )
      throw new Error(
        "each Rust exception requires a unique exact stable pin, reason, GitHub issue and future valid expiry date",
      );
    pins.add(entry["pin"]);
    return {
      pin: entry["pin"],
      reason: entry["reason"],
      tracking: entry["tracking"],
      expires: entry["expires"],
    };
  });
};

type RustReferenceOptions = {
  file: string;
  text: string;
  rust: string;
  exceptions: readonly RustException[];
};

/** Only executable fields are inspected: unrelated action inputs are not Rust selectors. */
export const checkRustReferences = ({
  file,
  text,
  rust,
  exceptions,
}: RustReferenceOptions) => {
  const diagnostics: {
    rule: "rust-version";
    path: string;
    line: number;
    message: string;
  }[] = [];
  const select = (value: unknown, label: string, line = 1) => {
    if (value === rust || exceptions.some(({ pin }) => pin === value)) return;
    diagnostics.push({
      rule: "rust-version",
      path: file,
      line,
      message: `${label} must be Rust ${rust}, found ${String(value)}`,
    });
  };
  const shell = (source: string, firstLine = 1) => {
    const commands = shellCommandSegments(source).map((words) =>
      words.map((word) => ({ value: decodeShellWord(word), line: firstLine })),
    );
    for (const command of commands) {
      let position = 0;
      const prefixes = new Set([
        "if",
        "then",
        "do",
        "elif",
        "!",
        "env",
        "sudo",
        "command",
        "exec",
        "time",
        "export",
        "readonly",
        "/usr/bin/env",
        "/bin/env",
      ]);
      while (position < command.length) {
        const value = command.at(position)?.value;
        if (value?.startsWith("RUSTUP_TOOLCHAIN="))
          select(
            value.slice("RUSTUP_TOOLCHAIN=".length),
            "RUSTUP_TOOLCHAIN",
            firstLine,
          );
        if (value === "-u" || value === "--unset") {
          position += 2;
          continue;
        }
        if (
          value?.startsWith("--unset=") ||
          value === "-i" ||
          value === "--ignore-environment"
        ) {
          position++;
          continue;
        }
        if (
          value !== undefined &&
          (prefixes.has(value) || /^[A-Za-z_][A-Za-z_\d]*=/.test(value))
        )
          position++;
        else break;
      }
      const executable = command.at(position)?.value;
      const arguments_ = command.slice(position + 1);
      if (executable === "cargo" && arguments_.at(0)?.value.startsWith("+")) {
        const selector = arguments_.at(0);
        select(selector?.value.slice(1), "cargo toolchain", selector?.line);
      }
      if (executable !== "rustup") continue;
      const subcommand = arguments_.at(0)?.value;
      if (subcommand === "target" || subcommand === "component") {
        // These commands name targets/components positionally; only this option selects Rust.
        for (let index = 1; index < arguments_.length; index++) {
          const token = arguments_.at(index);
          if (token?.value === "--toolchain") {
            select(
              arguments_.at(++index)?.value,
              "rustup --toolchain",
              token.line,
            );
          } else if (token?.value.startsWith("--toolchain=")) {
            select(
              token.value.slice("--toolchain=".length),
              "rustup --toolchain",
              token.line,
            );
          }
        }
        continue;
      }
      let selectors = arguments_;
      let requiresSelector = true;
      let firstSelectorOnly = false;
      if (
        subcommand === "default" ||
        subcommand === "install" ||
        subcommand === "update"
      ) {
        selectors = arguments_.slice(1);
        requiresSelector = subcommand !== "update";
      } else if (
        arguments_.at(0)?.value === "toolchain" &&
        (arguments_.at(1)?.value === "install" ||
          arguments_.at(1)?.value === "update")
      ) {
        selectors = arguments_.slice(2);
        requiresSelector = arguments_.at(1)?.value !== "update";
      } else if (arguments_.at(0)?.value === "run") {
        selectors = arguments_.slice(1);
        firstSelectorOnly = true;
      } else if (
        arguments_.at(0)?.value === "override" &&
        arguments_.at(1)?.value === "set"
      ) {
        selectors = arguments_.slice(2);
        firstSelectorOnly = true;
      } else continue;
      let selected = 0;
      const optionArguments = new Set([
        "--path",
        "--profile",
        "--component",
        "-c",
        "--target",
        "-t",
      ]);
      for (let index = 0; index < selectors.length; index++) {
        const token = selectors.at(index);
        if (token === undefined) continue;
        if (optionArguments.has(token.value)) {
          index++;
          continue;
        }
        if (token.value.startsWith("-")) continue;
        selected++;
        select(token.value, "rustup toolchain", token.line);
        if (firstSelectorOnly) break;
      }
      if (selected === 0 && requiresSelector)
        select(undefined, "rustup toolchain", firstLine);
    }
  };
  const lineOf = (token: string) => {
    const index = text.split(/\r?\n/).findIndex((line) => line.includes(token));
    return index < 0 ? 1 : index + 1;
  };
  if (isShellScript(file, text)) shell(text);
  if (/(?:^|\/)package\.json$/.test(file)) {
    try {
      const object: unknown = JSON.parse(text);
      if (record(object) && record(object["scripts"]))
        for (const [name, script] of Object.entries(object["scripts"]))
          if (typeof script === "string") shell(script, lineOf(`"${name}"`));
    } catch {
      /* The package owner reports invalid JSON. */
    }
  }
  if (/(?:^|\/)ci-service-images\.json$/.test(file)) {
    const images = (value: unknown) => {
      if (
        typeof value === "string" &&
        /^rust(?=:|@|$)/.test(canonicalDockerRuntime(value))
      ) {
        const tag = canonicalDockerRuntime(value)
          .replace(/^rust:?/, "")
          .split("@")
          .at(0);
        const version = tag === undefined ? undefined : rustImageVersion(tag);
        select(version, "Rust service image", lineOf(value));
      } else if (Array.isArray(value)) value.forEach(images);
      else if (record(value)) Object.values(value).forEach(images);
    };
    try {
      images(JSON.parse(text));
    } catch {
      diagnostics.push({
        rule: "rust-version",
        path: file,
        line: 1,
        message: "invalid service image JSON",
      });
    }
  }
  if (githubAutomationFileKind(file) === undefined) return diagnostics;
  const document = parseDocument(text);
  if (document.errors.length > 0) return diagnostics;
  try {
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!record(value)) return;
      if (
        record(value["env"]) &&
        value["env"]["RUSTUP_TOOLCHAIN"] !== undefined
      )
        select(
          value["env"]["RUSTUP_TOOLCHAIN"],
          "RUSTUP_TOOLCHAIN",
          lineOf("RUSTUP_TOOLCHAIN"),
        );
      if (typeof value["run"] === "string") shell(value["run"], lineOf("run:"));
      const uses = value["uses"];
      if (typeof uses === "string") {
        const action = uses.split("@").at(0)?.toLowerCase();
        const inputs = record(value["with"]) ? value["with"] : {};
        if (
          action === "dtolnay/rust-toolchain" ||
          action === "actions-rust-lang/setup-rust-toolchain"
        ) {
          const entries = Object.entries(inputs).filter(
            ([key]) => key.toLowerCase() === "toolchain",
          );
          if (entries.length !== 1)
            select(
              undefined,
              `${action} requires an explicit exact toolchain input`,
              lineOf(uses),
            );
          else {
            const selected = entries.at(0)?.at(1);
            // setup-rust-toolchain installs every comma-separated release.
            const selectors =
              action === "actions-rust-lang/setup-rust-toolchain" &&
              typeof selected === "string"
                ? selected.split(",").map((pin) => pin.trim())
                : [selected];
            for (const selector of selectors)
              select(selector, `${action} toolchain`, lineOf("toolchain:"));
          }
        } else if (
          /(?:^|\/)\.github\/workflows\/[^@]+\.ya?ml(?:@|$)/.test(uses)
        ) {
          for (const [key, selected] of Object.entries(inputs))
            if (["toolchain", "rust-toolchain"].includes(key.toLowerCase()))
              select(selected, `reusable workflow ${key}`, lineOf(`${key}:`));
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (key === "workflow_call" && record(child) && record(child["inputs"]))
          for (const [input, declaration] of Object.entries(child["inputs"]))
            if (
              ["toolchain", "rust-toolchain"].includes(input) &&
              record(declaration) &&
              declaration["default"] !== undefined
            )
              select(
                declaration["default"],
                `reusable workflow default ${input}`,
                lineOf("default:"),
              );
        visit(child);
      }
    };
    visit(document.toJS({ maxAliasCount: 100 }));
  } catch {
    /* The workflow owner reports alias resolution failures. */
  }
  return diagnostics;
};
