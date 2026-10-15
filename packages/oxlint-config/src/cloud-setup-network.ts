/** Shared deadlines cover retries and package-manager subprocesses. */
export const renderCloudNetwork = () => String.raw`
network_run() (
  local host="$1" seconds="$2" status=0
  shift 2
  set -o pipefail
  network_log="$(mktemp)" || return "$?"
  trap 'rm -f -- "$network_log"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if timeout --signal=TERM --kill-after=5s "$seconds"s "$@" 2>&1 | tee "$network_log"; then
    return 0
  else
    # Scalar Bash array expansion reads PIPESTATUS[0] before assignment resets it.
    status="$PIPESTATUS"
  fi
  [[ "$status" != 0 ]] || fail 'Cannot capture network command output'
  if [[ "$status" == 124 || "$status" == 137 || "$status" == 28 ]] || grep -Eiq 'timed[[:space:]-]+out|time[[:space:]-]+out|timeout[[:space:]]+(was[[:space:]]+)?(reached|expired)|(connection|operation|socket)[[:space:]-]+timeout' "$network_log"; then
    fail "download timed out: $host"
  fi
  return "$status"
)
download_file() {
  local url="$1" destination="$2" seconds="$3" host
  host="$(printf '%s\n' "$url" | cut -d/ -f3 | sed 's/.*@//')"
  [[ "$url" == https://* && -n "$host" ]] || fail 'Downloads require an HTTPS host'
  network_run "$host" "$seconds" curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 20 --max-time "$seconds" --retry 3 --retry-all-errors --retry-max-time "$seconds" "$url" -o "$destination"
}
apt_network() {
  local hosts
  # --print-uris reads configured indexes without contacting their servers.
  hosts="$(set -o pipefail; apt-get --print-uris update | awk -F/ '/^\047https?:\/\// { host=$3; sub(/.*@/, "", host); if (!seen[host]++) { printf "%s%s", separator, host; separator="," } }')" || return "$?"
  [[ -n "$hosts" ]] || hosts='configured APT hosts'
  # APT_DEADLINE: whole-call seconds; callers that also unpack packages may extend it.
  network_run "$hosts" "${"$"}{APT_DEADLINE:-180}" apt-get -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=3 -o APT::Update::Error-Mode=any "$@"
}
apt_refresh_for() {
  # Skip the refresh only when the install downloads nothing: then no package
  # source is contacted and stale cached indexes cannot point at missing files.
  local uris
  if uris="$(DEBIAN_FRONTEND=noninteractive apt-get --print-uris -qq -y --no-install-recommends install "$@" 2>/dev/null)" && [[ -z "$uris" ]]; then
    return 0
  fi
  apt_network update
}
`;
