/** Shared deadlines cover retries and package-manager subprocesses. */
export const renderCloudNetwork = () => String.raw`
release_log_holders() {
  # Processes left by package scripts may still hold a step log after the command exits.
  # Setup starts its own services later, so end them rather than let them write into a
  # deleted log for their whole lifetime.
  # One find over all descriptor links; no process per descriptor.
  local log="$1" root="${"$"}{CLOUD_PROC_ROOT:-/proc}" fd pid
  while IFS= read -r fd; do
    pid="${"$"}{fd%/fd/*}"
    pid="${"$"}{pid##*/}"
    [[ "$pid" =~ ^[0-9]+$ && "$pid" != "$$" ]] || continue
    kill -TERM "$pid" 2>/dev/null || true
  done < <(find "$root" -mindepth 3 -maxdepth 3 -path "$root/[0-9]*/fd/*" -lname "$log" 2>/dev/null)
}
network_run() (
  local host="$1" seconds="$2" status=0
  shift 2
  network_log="$(mktemp)" || return "$?"
  trap 'rm -f -- "$network_log"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # Output goes to a file, never a pipe: package scripts may leave processes that keep
  # inherited descriptors open, and a pipe reader would wait for them past the command.
  # Input is never the terminal: timeout runs the command outside the foreground process
  # group, where apt restoring terminal settings on a terminal stdin stops it for good.
  timeout --signal=TERM --kill-after=5s "$seconds"s "$@" < /dev/null > "$network_log" 2>&1 || status=$?
  release_log_holders "$network_log"
  cat -- "$network_log" || fail 'Cannot capture network command output'
  [[ "$status" != 0 ]] || return 0
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
