import type { getCloudSetupArtifact } from "./cloud-setup-artifacts";
import { cloudRustComponentBinaries } from "./cloud-setup-schema";
import type { resolveCloudToolchains } from "./cloud-setup-toolchains";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type ArtifactRelease = ReturnType<typeof getCloudSetupArtifact>;
const artifactSelection = (release: ArtifactRelease) => `case "$ARCH" in
${(["amd64", "arm64"] as const).map((arch) => `  ${arch}) artifact_url=${quote(release[arch].url)}; artifact_sha=${quote(release[arch].sha256)} ;;`).join("\n")}
esac`;

const helpers = String.raw`
fetch_verified() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 "$1" -o "$3"
  printf '%s  %s\n' "$2" "$3" | sha256sum --strict -c - >/dev/null
}
`;

const rustInstall = (
  rust: NonNullable<ReturnType<typeof resolveCloudToolchains>["rust"]>,
) => {
  const args = [
    ...rust.components.flatMap((name) => ["--component", name]),
    ...rust.targets.flatMap((name) => ["--target", name]),
  ]
    .map(quote)
    .join(" ");
  return String.raw`
export RUSTUP_HOME=/opt/stll-cloud/rustup
export CARGO_HOME=/opt/stll-cloud/cargo
export RUSTUP_TOOLCHAIN='@RUST@'
export RUSTUP_AUTO_INSTALL=0
rust_run() { runuser -u "$OUTPUT_USER" -- env HOME="$OUTPUT_HOME" RUSTUP_HOME="$RUSTUP_HOME" CARGO_HOME="$CARGO_HOME" RUSTUP_AUTO_INSTALL=0 RUSTUP_TOOLCHAIN=@RUST@ RUSTUP_DIST_SERVER=https://static.rust-lang.org RUSTUP_UPDATE_ROOT=https://static.rust-lang.org/rustup PATH="$PATH" "$@"; }
rust_ready() {
  local directory
  for directory in "$RUSTUP_HOME" "$CARGO_HOME"; do
    [[ -d "$directory" && ! -L "$directory" && "$(stat -c '%u' "$directory")" == "$OUTPUT_UID" ]] || return 1
  done
  [[ -x "$CARGO_HOME/bin/rustup" ]] || return 1
  [[ "$(rust_run "$CARGO_HOME/bin/rustup" --version 2>/dev/null)" == 'rustup @RUSTUP@ '* ]] || return 1
  [[ "$(rust_run "$CARGO_HOME/bin/rustc" +@RUST@ --version)" == 'rustc @RUST@ '* ]] || return 1
  local host
  host="$(rust_run "$CARGO_HOME/bin/rustc" +@RUST@ -vV | awk '$1 == "host:" { print $2 }')" || return 1
  @VERIFY_COMPONENTS@
  @VERIFY_TARGETS@
  return 0
}
verify_rust() { rust_ready || fail 'Pinned Rust, components or targets are unavailable; run install'; }
install_rust() (
  if ! command -v cc >/dev/null || ! command -v ld >/dev/null || [[ ! -f /usr/include/stdlib.h ]]; then
    apt-get update
    apt_install build-essential
  fi
  local scratch artifact_url artifact_sha
  scratch="$(mktemp -d)"
  trap 'rm -rf -- "$scratch"' EXIT
  for directory in "$RUSTUP_HOME" "$CARGO_HOME"; do
    [[ ! -L "$directory" ]] || fail 'Rust home must not be a symlink'
    if [[ -e "$directory" ]]; then
      [[ -d "$directory" && "$(stat -c '%u' "$directory")" == "$OUTPUT_UID" ]] || fail 'Rust home ownership differs from the invoking user'
    else
      install -d -m 755 -o "$OUTPUT_UID" -g "$OUTPUT_GID" "$directory"
    fi
  done
  if [[ ! -x "$CARGO_HOME/bin/rustup" ]] || [[ "$(rust_run "$CARGO_HOME/bin/rustup" --version 2>/dev/null)" != 'rustup @RUSTUP@ '* ]]; then
    @RUSTUP_ARTIFACT@
    fetch_verified "$artifact_url" "$artifact_sha" "$scratch/rustup-init"
    chmod 755 "$scratch" "$scratch/rustup-init"
    rust_run "$scratch/rustup-init" -y --no-modify-path --default-toolchain none --profile minimal
  fi
  rust_run "$CARGO_HOME/bin/rustup" set auto-self-update disable
  if ! rust_ready; then
    rust_run "$CARGO_HOME/bin/rustup" toolchain install @RUST@ --profile minimal --no-self-update @RUST_ARGS@
  fi
  rust_run "$CARGO_HOME/bin/rustup" default @RUST@
  verify_rust
  for tool in rustup cargo rustc rustdoc @RUST_PROXIES@; do
    # Launchers persist the system homes in fresh shells without profile sourcing.
    printf '%s\n' '#!/bin/sh' 'export RUSTUP_HOME=/opt/stll-cloud/rustup' 'export CARGO_HOME=/opt/stll-cloud/cargo' 'export RUSTUP_AUTO_INSTALL=0' 'export RUSTUP_TOOLCHAIN=@RUST@' "exec /opt/stll-cloud/cargo/bin/$tool \"\$@\"" > "$scratch/$tool"
    if ! cmp -s "$scratch/$tool" "/usr/local/bin/$tool"; then
      install -m 755 "$scratch/$tool" "/usr/local/bin/$tool"
    fi
  done
)
`
    .replaceAll("@RUSTUP@", rust.installer.version)
    .replaceAll("@RUST@", rust.channel)
    .replace("@RUSTUP_ARTIFACT@", artifactSelection(rust.installer))
    .replace("@RUST_ARGS@", args)
    .replace(
      "@RUST_PROXIES@",
      Object.entries(cloudRustComponentBinaries)
        .flatMap(([component, binaries]) =>
          rust.components.includes(component) ? Array.from(binaries) : [],
        )
        .join(" "),
    )
    .replace(
      "@VERIFY_COMPONENTS@",
      rust.components
        .map(
          (name) =>
            `rust_run "$CARGO_HOME/bin/rustup" component list --toolchain ${quote(rust.channel)} --installed | awk -v name=${quote(name)} -v host="$host" '$1 == name || $1 == name "-" host { found=1 } END { exit !found }' || return 1`,
        )
        .join("\n  "),
    )
    .replace(
      "@VERIFY_TARGETS@",
      rust.targets
        .map(
          (name) =>
            `rust_run "$CARGO_HOME/bin/rustup" target list --toolchain ${quote(rust.channel)} --installed | awk -v name=${quote(name)} '$1 == name { found=1 } END { exit !found }' || return 1`,
        )
        .join("\n  "),
    );
};

export const renderCloudToolInstall = ({
  rust,
  tools,
}: ReturnType<typeof resolveCloudToolchains>) => {
  const installs = tools.map(({ tool, release }) => {
    const directory = `/opt/stll-cloud/tools/${tool}/${release.version}`;
    const command = tool === "wasm-bindgen-cli" ? "wasm-bindgen" : tool;
    const versionPrefix = tool === "cargo-nextest" ? "cargo-nextest" : command;
    const marker = `${versionPrefix} ${release.version}`;
    return {
      name: tool.replaceAll("-", "_"),
      text: `verify_${tool.replaceAll("-", "_")}() {
  ${Object.keys(release.amd64.binaries)
    .map((binary) => `[[ -x ${quote(`${directory}/${binary}`)} ]] || return 1`)
    .join("\n  ")}
  [[ "$( ${quote(`${directory}/${command}`)} --version)" == ${quote(marker)} || "$( ${quote(`${directory}/${command}`)} --version)" == ${quote(`${marker} `)}* ]]
}
install_${tool.replaceAll("-", "_")}() (
  local scratch artifact_url artifact_sha
  if ! verify_${tool.replaceAll("-", "_")}; then
    scratch="$(mktemp -d)"
    trap 'rm -rf -- "$scratch"' EXIT
    ${artifactSelection(release)}
    fetch_verified "$artifact_url" "$artifact_sha" "$scratch/archive.tar.gz"
    tar -xzf "$scratch/archive.tar.gz" -C "$scratch"
    install -d -m 755 ${quote(directory)}
    case "$ARCH" in
${(["amd64", "arm64"] as const)
  .map(
    (arch) =>
      `      ${arch})\n${Object.entries(release[arch].binaries)
        .map(
          ([binary, path]) =>
            `        install -m 755 "$scratch/${path}" ${quote(`${directory}/${binary}`)}`,
        )
        .join("\n")}\n        ;;`,
  )
  .join("\n")}
    esac
    verify_${tool.replaceAll("-", "_")} || fail ${quote(`Installed ${tool} version differs from its pin`)}
  fi
${Object.keys(release.amd64.binaries)
  .map(
    (binary) =>
      `  ln -sfnT -- ${quote(`${directory}/${binary}`)} ${quote(`/usr/local/bin/${binary}`)}`,
  )
  .join("\n")}
)
`,
    };
  });
  return `${helpers}${rust === undefined ? "" : rustInstall(rust)}\n${installs.map(({ text }) => text).join("\n")}
install_tools() {
  ${rust === undefined ? ":" : "install_rust"}
  ${installs.map(({ name }) => `install_${name}`).join("\n  ")}
}
verify_tools() {
  ${rust === undefined ? ":" : "verify_rust"}
  ${installs.map(({ name }) => `verify_${name} || fail 'Pinned ${name} is unavailable; run install'`).join("\n  ")}
}
`;
};
