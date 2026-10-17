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
  download_file "$1" "$3" 120
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
rust_run() {
  local mode="$1"
  shift
  set -- runuser -u "$OUTPUT_USER" -- env HOME="$OUTPUT_HOME" RUSTUP_HOME="$RUSTUP_HOME" CARGO_HOME="$CARGO_HOME" RUSTUP_AUTO_INSTALL=0 RUSTUP_TOOLCHAIN=@RUST@ RUSTUP_DIST_SERVER=https://static.rust-lang.org RUSTUP_UPDATE_ROOT=https://static.rust-lang.org/rustup PATH="$PATH" "$@"
  case "$mode" in
    local) "$@" ;;
    network) network_run static.rust-lang.org 180 "$@" ;;
    *) fail 'Invalid Rust execution mode' ;;
  esac
}
primary_rust_ready() {
  local directory
  for directory in "$RUSTUP_HOME" "$CARGO_HOME"; do
    [[ -d "$directory" && ! -L "$directory" && "$(stat -c '%u' "$directory")" == "$OUTPUT_UID" ]] || return 1
  done
  [[ -x "$CARGO_HOME/bin/rustup" ]] || return 1
  [[ "$(rust_run local "$CARGO_HOME/bin/rustup" --version 2>/dev/null)" == 'rustup @RUSTUP@ '* ]] || return 1
  [[ "$(rust_run local "$CARGO_HOME/bin/rustc" +@RUST@ --version)" == 'rustc @RUST@ '* ]] || return 1
  local host
  host="$(rust_run local "$CARGO_HOME/bin/rustc" +@RUST@ -vV | awk '$1 == "host:" { print $2 }')" || return 1
  @VERIFY_COMPONENTS@
  @VERIFY_TARGETS@
  return 0
}
rust_ready() {
  local additional_version
  primary_rust_ready || return 1
  @VERIFY_ADDITIONAL_TOOLCHAINS@
  return 0
}
verify_rust() { rust_ready || fail 'Pinned Rust, components or targets are unavailable; run install'; }
install_rust() (
  if ! command -v cc >/dev/null || ! command -v ld >/dev/null || [[ ! -f /usr/include/stdlib.h ]]; then
    apt_refresh_for build-essential
    apt_install build-essential
  fi
  local artifact_url artifact_sha additional_version
  # Subshell scope retains scratch for EXIT cleanup after a failed command.
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
  if [[ ! -x "$CARGO_HOME/bin/rustup" ]] || [[ "$(rust_run local "$CARGO_HOME/bin/rustup" --version 2>/dev/null)" != 'rustup @RUSTUP@ '* ]]; then
    @RUSTUP_ARTIFACT@
    fetch_verified "$artifact_url" "$artifact_sha" "$scratch/rustup-init"
    chmod 755 "$scratch" "$scratch/rustup-init"
    rust_run network "$scratch/rustup-init" -y --no-modify-path --default-toolchain none --profile minimal
  fi
  rust_run local "$CARGO_HOME/bin/rustup" set auto-self-update disable
  if ! primary_rust_ready; then
    rust_run network "$CARGO_HOME/bin/rustup" toolchain install @RUST@ --profile minimal --no-self-update @RUST_ARGS@
  fi
  @INSTALL_ADDITIONAL_TOOLCHAINS@
  rust_run local "$CARGO_HOME/bin/rustup" default @RUST@
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
    .replace(
      "@VERIFY_ADDITIONAL_TOOLCHAINS@",
      rust.additionalToolchains
        .map(
          (pin) =>
            `additional_version="$(rust_run local "$CARGO_HOME/bin/rustc" +${pin} --version)" || return 1\n  [[ "$additional_version" == 'rustc ${pin} '* ]] || return 1`,
        )
        .join("\n  "),
    )
    .replace(
      "@INSTALL_ADDITIONAL_TOOLCHAINS@",
      rust.additionalToolchains
        .map(
          (pin) =>
            `if ! additional_version="$(rust_run local "$CARGO_HOME/bin/rustc" +${pin} --version)" || [[ "$additional_version" != 'rustc ${pin} '* ]]; then\n    rust_run network "$CARGO_HOME/bin/rustup" toolchain install ${pin} --profile minimal --no-self-update\n  fi`,
        )
        .join("\n  "),
    )
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
            `rust_run local "$CARGO_HOME/bin/rustup" component list --toolchain ${quote(rust.channel)} --installed | awk -v name=${quote(name)} -v host="$host" '$1 == name || $1 == name "-" host { found=1 } END { exit !found }' || return 1`,
        )
        .join("\n  "),
    )
    .replace(
      "@VERIFY_TARGETS@",
      rust.targets
        .map(
          (name) =>
            `rust_run local "$CARGO_HOME/bin/rustup" target list --toolchain ${quote(rust.channel)} --installed | awk -v name=${quote(name)} '$1 == name { found=1 } END { exit !found }' || return 1`,
        )
        .join("\n  "),
    );
};

type CloudToolEntry = ReturnType<
  typeof resolveCloudToolchains
>["tools"][number];

// Present packages are reused; apt never downgrades or replaces them.
const packageToolInstall = ({
  tool,
  release,
}: Extract<CloudToolEntry, { type: "package" }>) => {
  const name = tool.replaceAll("-", "_");
  return {
    name,
    text: `verify_${name}() {
  [[ -x ${quote(release.binary)} && "$(${quote(release.binary)} --version 2>/dev/null)" == ${quote(release.identity)}* ]] || return 1
  [[ "$(dpkg-query -W -f='\${Version}' ${quote(release.package)} 2>/dev/null)" == ${quote(`${release.version}-`)}* ]]
}
install_${name}() {
  if ! verify_${name}; then
    apt_network update
    apt_install ${quote(release.package)}
    verify_${name} || fail ${quote(`Installed ${tool} version differs from its pin`)}
  fi
}
`,
  };
};

const artifactToolInstall = ({
  tool,
  release,
}: Extract<CloudToolEntry, { type: "artifact" }>) => {
  const directory = `/opt/stll-cloud/tools/${tool}/${release.version}`;
  const command = tool === "wasm-bindgen-cli" ? "wasm-bindgen" : tool;
  const versionPrefix = tool === "gitleaks" ? "gitleaks version" : command;
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
  local artifact_url artifact_sha
  # Subshell scope retains scratch for EXIT cleanup after a failed command.
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
};

export const renderCloudToolInstall = ({
  rust,
  tools,
}: ReturnType<typeof resolveCloudToolchains>) => {
  const installs = tools.map((entry) => {
    switch (entry.type) {
      case "package":
        return packageToolInstall(entry);
      case "artifact":
        return artifactToolInstall(entry);
      default: {
        const exhaustive: never = entry;
        throw new Error(`Unsupported cloud tool: ${String(exhaustive)}`);
      }
    }
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
