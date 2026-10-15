import { parse as parseToml } from "smol-toml";

import {
  cloudSetupArtifacts,
  getCloudSetupArtifact,
} from "./cloud-setup-artifacts";
import { cloudExtraTools, parseCloudRustNames } from "./cloud-setup-schema";
import type { parseCloudSetup } from "./cloud-setup-schema";
import type { RustException } from "./toolchain-rust";

type ResolveCloudToolchainsOptions = {
  cloud: NonNullable<ReturnType<typeof parseCloudSetup>>;
  files: Readonly<Record<string, string>>;
  rust: string;
  rustExceptions: readonly RustException[];
};
const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input);
/** Resolve the same tracked snapshot for generation and the mandatory drift check. */
export const resolveCloudToolchains = ({
  cloud,
  files,
  rust,
  rustExceptions,
}: ResolveCloudToolchainsOptions) => {
  const source = files["rust-toolchain.toml"];
  const selector = files["rust-toolchain"];
  if (source !== undefined && selector !== undefined)
    throw new Error(
      "cloud Rust requires one root rust-toolchain.toml or rust-toolchain file",
    );
  let declared: Record<string, unknown> | undefined;
  if (source !== undefined || selector?.trimStart().startsWith("[")) {
    const parsed = parseToml(source ?? selector ?? "");
    if (!record(parsed["toolchain"]))
      throw new Error("cloud Rust requires [toolchain]");
    declared = parsed["toolchain"];
    if (
      Object.keys(declared).some(
        (key) => !["channel", "components", "targets", "profile"].includes(key),
      )
    )
      throw new Error(
        "cloud Rust supports only channel, components, targets and profile",
      );
    if (declared["profile"] !== undefined && declared["profile"] !== "minimal")
      throw new Error(
        "cloud Rust requires profile = minimal; declare required components explicitly",
      );
  } else if (selector !== undefined) declared = { channel: selector.trim() };
  const rustEnabled = declared !== undefined || cloud.rust !== undefined;
  const channel =
    declared === undefined
      ? (cloud.rust?.toolchain ?? rust)
      : declared["channel"];
  if (rustEnabled) {
    if (typeof channel !== "string" || !/^\d+\.\d+\.\d+$/.test(channel))
      throw new Error("cloud Rust requires an exact stable toolchain");
    if (channel !== rust && !rustExceptions.some(({ pin }) => pin === channel))
      throw new Error(
        `cloud Rust must use shared Rust ${rust} or a recorded rustExceptions pin`,
      );
    if (cloud.rust?.toolchain !== undefined && cloud.rust.toolchain !== channel)
      throw new Error(
        "cloud.rust.toolchain conflicts with root Rust toolchain",
      );
  }
  const components = [
    ...new Set([
      ...parseCloudRustNames(declared?.["components"], "components"),
      ...(cloud.rust?.components ?? []),
    ]),
  ].sort();
  const targets = [
    ...new Set([
      ...parseCloudRustNames(declared?.["targets"], "targets"),
      ...(cloud.rust?.targets ?? []),
    ]),
  ].sort();
  const tools = cloudExtraTools.flatMap((tool) => {
    const version = cloud.tools?.[tool];
    if (version === undefined) return [];
    if (tool === "cargo-nextest" && !rustEnabled)
      throw new Error("cloud.tools.cargo-nextest requires a Rust toolchain");
    if (tool === "wasm-bindgen-cli") {
      const lock = files["Cargo.lock"];
      if (lock === undefined)
        throw new Error("wasm-bindgen-cli requires tracked root Cargo.lock");
      const packages = parseToml(lock)["package"];
      if (!Array.isArray(packages))
        throw new Error(
          "Cargo.lock requires package entries for wasm-bindgen-cli",
        );
      const versions = new Set(
        packages.flatMap((entry: unknown) =>
          record(entry) && entry["name"] === "wasm-bindgen"
            ? [entry["version"]]
            : [],
        ),
      );
      if (versions.size !== 1 || !versions.has(version))
        throw new Error(
          `cloud.tools.wasm-bindgen-cli ${version} must equal the unique wasm-bindgen crate version in Cargo.lock (found ${[...versions].join(", ") || "none"})`,
        );
    }
    return [{ tool, release: getCloudSetupArtifact(tool, version) }];
  });
  return {
    rust:
      rustEnabled && typeof channel === "string"
        ? {
            channel,
            components,
            targets,
            installer: cloudSetupArtifacts["rustup-init"],
          }
        : undefined,
    tools,
  };
};
