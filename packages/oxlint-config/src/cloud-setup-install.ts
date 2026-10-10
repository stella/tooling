import type { CloudService } from "./cloud-setup-schema";
import type { parseToolchainPolicy } from "./toolchain-schema";

type CloudServiceInstallOptions = {
  services: readonly CloudService[];
  postgres: string;
  valkey: string;
  valkeyArtifacts: ReturnType<typeof parseToolchainPolicy>["valkeyArtifacts"];
};

const packageInstall = String.raw`
# Prevent package maintainer scripts from starting unmanaged system services.
apt_install() (
  local backup policy_state=untouched
  [[ ! -L /var/lock/stll-cloud-apt.lock ]] || fail 'Invalid package install lock'
  exec 8>/var/lock/stll-cloud-apt.lock
  flock -x -w 120 8 || fail 'Another package installation is active'
  [[ ! -L /usr/sbin/policy-rc.d ]] || fail 'Unsupported service-start policy symlink'
  [[ ! -e /usr/sbin/policy-rc.d || -f /usr/sbin/policy-rc.d ]] || fail 'Unsupported service-start policy file'
  backup="$(mktemp -d)"
  cleanup_package_policy() {
    local status=$?
    trap - EXIT HUP INT TERM
    if [[ "$policy_state" == installed ]]; then
      if [[ -f "$backup/original" ]]; then
        if ! cp -p "$backup/original" /usr/sbin/policy-rc.d; then status=1; fi
      else
        if ! rm -f /usr/sbin/policy-rc.d; then status=1; fi
      fi
    fi
    rm -rf -- "$backup"
    exit "$status"
  }
  trap cleanup_package_policy EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [[ -e /usr/sbin/policy-rc.d ]]; then cp -p /usr/sbin/policy-rc.d "$backup/original"; fi
  policy_state=installed
  printf '%s\n' '#!/bin/sh' 'exit 101' > /usr/sbin/policy-rc.d
  chmod 755 /usr/sbin/policy-rc.d
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --allow-downgrades "$@"
)

`;

const postgresInstall = String.raw`
  postgres_ready() {
    local binary
    for binary in postgres initdb pg_ctl psql createdb; do
      [[ -x "/usr/lib/postgresql/@POSTGRES@/bin/$binary" ]] || return 1
    done
    /usr/lib/postgresql/@POSTGRES@/bin/postgres --version | grep -Eq '^postgres \(PostgreSQL\) @POSTGRES@\.'
  }
  if ! postgres_ready; then
    local key key_fingerprint
    key="$(mktemp)"
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$key"
    key_fingerprint="$(gpg --batch --show-keys --with-colons "$key" | awk -F: '$1 == "fpr" { print $10; exit }')"
    [[ "$key_fingerprint" == B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8 ]] || fail 'PostgreSQL signing key mismatch'
    install -d -m 755 /usr/share/keyrings
    install -m 644 "$key" /usr/share/keyrings/stll-pgdg.asc
    rm -- "$key"
    printf '%s\n' 'deb [signed-by=/usr/share/keyrings/stll-pgdg.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main' > /etc/apt/sources.list.d/stll-pgdg.list
    apt-get update
    apt_install postgresql-@POSTGRES@ postgresql-client-@POSTGRES@
  fi
  postgres_ready || fail 'PostgreSQL toolchain is incomplete or differs from the policy major'
`;

const valkeyInstall = String.raw`
  if ! command -v valkey-server >/dev/null || [[ "$(valkey-server --version | sed -nE 's/.*v=([0-9.]+).*/\1/p')" != '@VALKEY@' ]] || ! command -v valkey-cli >/dev/null || [[ "$(valkey-cli --version)" != 'valkey-cli @VALKEY@' ]]; then
    local scratch server_url server_sha tools_url tools_sha package
    scratch="$(mktemp -d)"
    chmod 755 "$scratch"
    case "$ARCH" in
      amd64) server_url='@AMD64_SERVER_URL@'; server_sha='@AMD64_SERVER_SHA@'; tools_url='@AMD64_TOOLS_URL@'; tools_sha='@AMD64_TOOLS_SHA@' ;;
      arm64) server_url='@ARM64_SERVER_URL@'; server_sha='@ARM64_SERVER_SHA@'; tools_url='@ARM64_TOOLS_URL@'; tools_sha='@ARM64_TOOLS_SHA@' ;;
      *) fail 'Unsupported Valkey architecture' ;;
    esac
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 "$server_url" -o "$scratch/valkey-server.deb"
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 "$tools_url" -o "$scratch/valkey-tools.deb"
    (cd "$scratch"; printf '%s  %s\n' "$server_sha" valkey-server.deb "$tools_sha" valkey-tools.deb | sha256sum --strict -c -)
    for package in valkey-server valkey-tools; do
      [[ "$(dpkg-deb -f "$scratch/$package.deb" Package)" == "$package" ]] || fail 'Valkey artifact package mismatch'
      [[ "$(dpkg-deb -f "$scratch/$package.deb" Version)" == '@VALKEY@-1.noble' ]] || fail 'Valkey artifact version mismatch'
      [[ "$(dpkg-deb -f "$scratch/$package.deb" Architecture)" == "$ARCH" ]] || fail 'Valkey artifact architecture mismatch'
    done
    apt-get update
    apt_install "$scratch/valkey-server.deb" "$scratch/valkey-tools.deb"
    rm -rf -- "$scratch"
  fi
  [[ "$(valkey-server --version | sed -nE 's/.*v=([0-9.]+).*/\1/p')" == '@VALKEY@' ]] || fail 'Valkey version differs from policy'
  [[ "$(valkey-cli --version)" == 'valkey-cli @VALKEY@' ]] || fail 'Valkey client version differs from policy'
`;

const state = String.raw`
service_account_ready() {
  local uid gid shell
  uid="$(id -u stll-cloud)" || fail 'Service user is unavailable; run install'
  gid="$(id -g stll-cloud)"
  shell="$(getent passwd stll-cloud | cut -d: -f7)"
  [[ "$uid" =~ ^[1-9][0-9]*$ && "$gid" =~ ^[1-9][0-9]*$ && "$shell" == /usr/sbin/nologin ]] || fail 'Service user must be unprivileged with no login shell'
}
prepare_state() {
  service_account_ready
  [[ ! -L /var/lib/stll-cloud ]] || fail 'Service state root must not be a symlink'
  if [[ -e /var/lib/stll-cloud ]]; then
    [[ -d /var/lib/stll-cloud && "$(stat -c '%u:%a' /var/lib/stll-cloud)" == 0:755 ]] || fail 'Invalid service state root'
  else
    install -d -m 755 -o root -g root /var/lib/stll-cloud
  fi
  STATE="/var/lib/stll-cloud/$(printf '%s' "$REPO_ROOT" | sha256sum | cut -d' ' -f1)"
  [[ ! -L "$STATE" ]] || fail 'Service state must not be a symlink'
  if [[ -e "$STATE" ]]; then
    [[ -d "$STATE" && "$(stat -c '%u:%a' "$STATE")" == 0:710 && "$(stat -c '%g' "$STATE")" == "$(id -g stll-cloud)" ]] || fail 'Invalid service state ownership'
  else
    install -d -m 710 -o root -g stll-cloud "$STATE"
  fi
  [[ ! -L "$STATE/lock" ]] || fail 'Service lock must not be a symlink'
  exec 9>"$STATE/lock"
  flock -x -w 10 9 || fail 'Another setup process owns the service state'
}
`;

export const renderCloudServiceInstall = ({
  services,
  postgres,
  valkey,
  valkeyArtifacts,
}: CloudServiceInstallOptions) => {
  const parts = services.map((service) => {
    switch (service) {
      case "postgres":
        return postgresInstall.replaceAll("@POSTGRES@", postgres);
      case "valkey": {
        const replacements = new Map([
          ["@VALKEY@", valkey],
          ["@AMD64_SERVER_URL@", valkeyArtifacts.amd64.server.url],
          ["@AMD64_SERVER_SHA@", valkeyArtifacts.amd64.server.sha256],
          ["@AMD64_TOOLS_URL@", valkeyArtifacts.amd64.tools.url],
          ["@AMD64_TOOLS_SHA@", valkeyArtifacts.amd64.tools.sha256],
          ["@ARM64_SERVER_URL@", valkeyArtifacts.arm64.server.url],
          ["@ARM64_SERVER_SHA@", valkeyArtifacts.arm64.server.sha256],
          ["@ARM64_TOOLS_URL@", valkeyArtifacts.arm64.tools.url],
          ["@ARM64_TOOLS_SHA@", valkeyArtifacts.arm64.tools.sha256],
        ]);
        return valkeyInstall.replace(/@[A-Z0-9_]+@/g, (token) => {
          const value = replacements.get(token);
          if (value === undefined)
            throw new Error(`Missing Valkey artifact field: ${token}`);
          return value;
        });
      }
      default: {
        const exhaustive: never = service;
        throw new Error(`Unsupported service: ${exhaustive}`);
      }
    }
  });
  const user =
    services.length === 0
      ? ""
      : "  if ! id stll-cloud >/dev/null 2>&1; then useradd --system --user-group --no-create-home --shell /usr/sbin/nologin stll-cloud; fi\n  service_account_ready\n";
  return `${packageInstall}\n${services.length === 0 ? "prepare_state() { :; }\n" : state}\ninstall_services() {\n${user}${parts.join("")}\n  :\n}\n`;
};
