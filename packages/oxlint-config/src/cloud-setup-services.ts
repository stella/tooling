import type { CloudService } from "./cloud-setup-schema";

type CloudServiceStartOptions = {
  services: readonly CloudService[];
  postgres: string;
  valkey: string;
};

const common = String.raw`
service_file() {
  local file="$1" owner="$2"
  [[ ! -L "$file" ]] || fail "Service state must not contain symbolic links"
  if [[ -e "$file" ]]; then
    [[ -f "$file" && "$(stat -c '%u:%a' "$file")" == "$owner:600" ]] || fail "Invalid service state file"
  fi
}
service_directory() {
  local directory="$1"
  [[ ! -L "$directory" ]] || fail "Service directory must not be a symbolic link"
  if [[ -e "$directory" ]]; then
    [[ -d "$directory" && "$(stat -c '%u:%a' "$directory")" == "$SERVICE_UID:700" ]] || fail "Invalid service directory"
  else
    root install -d -m 700 -o stll-cloud -g stll-cloud "$directory"
  fi
}
service_password() {
  local file="$1"
  service_file "$file" 0
  if [[ ! -e "$file" ]]; then
    (umask 077; openssl rand -hex 32 > "$file")
    root chown root:root "$file"
  fi
  [[ "$(cat "$file")" =~ ^[0-9a-f]{64}$ ]] || fail "Invalid service credential state"
}
service_process_matches() {
  local pid="$1" executable="$2" owner actual expected
  [[ "$pid" =~ ^[1-9][0-9]*$ && -d "/proc/$pid" ]] || return 1
  owner="$(stat -c '%u' "/proc/$pid" 2>/dev/null)" || return 2
  [[ "$owner" =~ ^[0-9]+$ ]] || return 2
  [[ "$owner" == "$SERVICE_UID" ]] || return 1
  actual="$(readlink -f "/proc/$pid/exe" 2>/dev/null)" || return 2
  expected="$(readlink -f "$executable")" || return 2
  [[ -n "$actual" && -n "$expected" && "$actual" != *' (deleted)' ]] || return 2
  [[ "$actual" == "$expected" ]]
}
service_process() {
  service_process_matches "$1" "$2" || fail "Managed service process identity differs from the recorded state"
}
service_prune_pid() {
  local file="$1" executable="$2" service="$3" pid identity
  [[ -e "$file" ]] || return 0
  pid="$(head -n 1 "$file")"
  # PostgreSQL encodes a standalone backend with a negative PID.
  if [[ "$service" == postgres ]]; then pid="$(printf '%s' "$pid" | sed 's/^-//')"; fi
  if service_process_matches "$pid" "$executable"; then return 0; else identity=$?; fi
  [[ "$identity" != 2 ]] || fail "Cannot verify recorded live service process; retaining its PID file"
  # Let PostgreSQL check orphan shared memory before removing a dead-PID lock.
  if [[ "$service" == postgres && "$pid" =~ ^[1-9][0-9]*$ && ! -d "/proc/$pid" ]]; then return 0; fi
  if [[ "$service" == postgres ]]; then
    [[ "$pid" =~ ^[1-9][0-9]*$ && "$SERVICE_UID" != 0 ]] || fail "Cannot safely recover PostgreSQL PID state"
    # The root controller is not our nonroot postgres. Preserve the remaining
    # lock rows so PostgreSQL's EPERM/ancestor path still checks orphan memory.
    root sed -i "1s/.*/$$/" "$file"
    return 0
  fi
  # Restored state can name an unrelated live process; never signal that PID.
  root rm -- "$file"
}
`;

const postgresStart = String.raw`
  local pg_bin='/usr/lib/postgresql/@POSTGRES@/bin' pg_data="$STATE/postgres" pg_password pg_details pg_pid pg_version
  service_password "$STATE/postgres.password"
  pg_password="$(cat "$STATE/postgres.password")"
  service_directory "$pg_data"
  for file in PG_VERSION postmaster.pid postgresql.conf pg_hba.conf pg_ident.conf postgresql.auto.conf; do
    service_file "$pg_data/$file" "$SERVICE_UID"
  done
  if [[ ! -e "$pg_data/PG_VERSION" ]]; then
    [[ -z "$(ls -A "$pg_data")" ]] || fail "PostgreSQL data directory is not initialized"
    service_file "$STATE/postgres.init-password" "$SERVICE_UID"
    (umask 077; printf '%s\n' "$pg_password" > "$STATE/postgres.init-password")
    root chown stll-cloud:stll-cloud "$STATE/postgres.init-password"
    service_run env PGHOST=127.0.0.1 PGHOSTADDR=127.0.0.1 "$pg_bin/initdb" -D "$pg_data" --username=stll_cloud --auth-host=scram-sha-256 --auth-local=scram-sha-256 --pwfile="$STATE/postgres.init-password" --encoding=UTF8 --locale=C --set=unix_socket_directories= >/dev/null || fail "PostgreSQL initialization failed"
    root rm "$STATE/postgres.init-password"
  fi
  [[ -f "$pg_data/PG_VERSION" && "$(cat "$pg_data/PG_VERSION")" == '@POSTGRES@' ]] || fail "PostgreSQL data has a different major version"
  service_prune_pid "$pg_data/postmaster.pid" "$pg_bin/postgres" postgres
  if ! service_run env PGHOST=127.0.0.1 PGHOSTADDR=127.0.0.1 "$pg_bin/pg_ctl" -D "$pg_data" status >/dev/null 2>&1; then
    service_run env PGHOST=127.0.0.1 PGHOSTADDR=127.0.0.1 "$pg_bin/pg_ctl" -D "$pg_data" -l "$pg_data/cloud.log" -o "-h 127.0.0.1 -p 55432 -c unix_socket_directories=" -t 10 -w start >/dev/null || fail "PostgreSQL start failed; port 55432 must be available"
  fi
  pg_details="$(env -u PGSERVICE -u PGSERVICEFILE -u PGOPTIONS PGHOSTADDR=127.0.0.1 PGPASSWORD="$pg_password" PGCONNECT_TIMEOUT=2 "$pg_bin/psql" -X -h 127.0.0.1 -p 55432 -U stll_cloud -d postgres -At -v ON_ERROR_STOP=1 -c "SELECT current_setting('data_directory'), current_setting('listen_addresses'), current_setting('port'), current_setting('server_version_num'), current_setting('unix_socket_directories')")" || fail "PostgreSQL authenticated readiness failed"
  pg_version="$(printf '%s\n' "$pg_details" | cut -d '|' -f4)"
  [[ "$pg_details" == "$pg_data|127.0.0.1|55432|$pg_version|" && "$pg_version" =~ ^[0-9]{6}$ ]] || fail "PostgreSQL endpoint does not match managed data and listener"
  (( pg_version / 10000 == @POSTGRES@ )) || fail "PostgreSQL endpoint has a different major version"
  pg_pid="$(head -n 1 "$pg_data/postmaster.pid")"
  service_process "$pg_pid" "$pg_bin/postgres"
  [[ "$(env -u PGSERVICE -u PGSERVICEFILE -u PGOPTIONS PGHOSTADDR=127.0.0.1 PGPASSWORD="$pg_password" PGCONNECT_TIMEOUT=2 "$pg_bin/psql" -X -h 127.0.0.1 -p 55432 -U stll_cloud -d postgres -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_database WHERE datname = 'cloud_test'")" == 1 ]] || env -u PGSERVICE -u PGSERVICEFILE -u PGOPTIONS PGHOSTADDR=127.0.0.1 PGPASSWORD="$pg_password" PGCONNECT_TIMEOUT=2 "$pg_bin/createdb" -h 127.0.0.1 -p 55432 -U stll_cloud cloud_test || fail "PostgreSQL test database creation failed"
  DATABASE_URL="postgresql://stll_cloud:$pg_password@127.0.0.1:55432/cloud_test"
`;

const valkeyStart = String.raw`
  local vk_data="$STATE/valkey" vk_password vk_config vk_info vk_pid vk_expected ready=0
  service_password "$STATE/valkey.password"
  vk_password="$(cat "$STATE/valkey.password")"
  service_directory "$vk_data"
  vk_config="$vk_data/valkey.conf"
  service_file "$vk_config" "$SERVICE_UID"
  for file in valkey.pid valkey.log dump.rdb; do
    [[ ! -L "$vk_data/$file" ]] || fail "Valkey state must not contain symbolic links"
    if [[ -e "$vk_data/$file" ]]; then
      [[ -f "$vk_data/$file" && "$(stat -c '%u' "$vk_data/$file")" == "$SERVICE_UID" ]] || fail "Invalid Valkey state file"
    fi
  done
  vk_expected="$(printf '%s\n' 'bind 127.0.0.1' 'port 56379' 'protected-mode yes' 'daemonize yes' "requirepass $vk_password" "dir $vk_data" "pidfile $vk_data/valkey.pid" "logfile $vk_data/valkey.log" 'save ""' 'appendonly no')"
  if [[ ! -e "$vk_config" ]]; then
    (umask 077; printf '%s\n' "$vk_expected" > "$vk_config")
    root chown stll-cloud:stll-cloud "$vk_config"
  fi
  [[ "$(cat "$vk_config")" == "$vk_expected" ]] || fail "Valkey configuration differs from managed settings"
  service_prune_pid "$vk_data/valkey.pid" "$(command -v valkey-server)" valkey
  if [[ ! -e "$vk_data/valkey.pid" ]]; then
    service_run valkey-server "$vk_config" || fail "Valkey start failed; port 56379 must be available"
  fi
  for ((attempt=0; attempt<20; attempt++)); do
    if vk_info="$(VALKEYCLI_AUTH="$vk_password" timeout 0.2 valkey-cli -h 127.0.0.1 -p 56379 --raw INFO server 2>/dev/null)"; then
      if [[ "$vk_info" == *$'valkey_version:@VALKEY@\r\n'* && "$vk_info" == *"config_file:$vk_config"$'\r\n'* ]]; then ready=1; break; fi
    fi
    sleep 0.25
  done
  [[ "$ready" == 1 ]] || fail "Valkey authenticated readiness or managed version/configuration check failed"
  [[ -f "$vk_data/valkey.pid" ]] || fail "Valkey managed process identifier is unavailable"
  vk_pid="$(cat "$vk_data/valkey.pid")"
  service_process "$vk_pid" "$(command -v valkey-server)"
  [[ "$vk_info" == *"process_id:$vk_pid"$'\r\n'* ]] || fail "Valkey endpoint has a different process identifier"
  [[ "$(VALKEYCLI_AUTH="$vk_password" timeout 2 valkey-cli -h 127.0.0.1 -p 56379 --raw CONFIG GET bind)" == $'bind\n127.0.0.1' ]] || fail "Valkey endpoint must bind only loopback"
  [[ "$(VALKEYCLI_AUTH="$vk_password" timeout 2 valkey-cli -h 127.0.0.1 -p 56379 --raw CONFIG GET dir)" == "$(printf 'dir\n%s' "$vk_data")" ]] || fail "Valkey endpoint has a different data directory"
  REDIS_URL="redis://:$vk_password@127.0.0.1:56379/0"
`;

/** Render only declared services; installation and environment-file ownership stay with the caller. */
export const renderCloudServiceStart = ({
  services,
  postgres,
  valkey,
}: CloudServiceStartOptions): string => {
  if (!/^[1-9][0-9]*$/.test(postgres) || !/^\d+\.\d+\.\d+$/.test(valkey))
    throw new Error("Invalid cloud service runtime policy");
  if (services.length === 0) return "start_services() { :; }\n";
  const bodies = services.map((service) => {
    switch (service) {
      case "postgres":
        return postgresStart.replaceAll("@POSTGRES@", postgres);
      case "valkey":
        return valkeyStart.replaceAll("@VALKEY@", valkey);
      default: {
        const exhaustive: never = service;
        throw new Error(`Unsupported cloud service: ${exhaustive}`);
      }
    }
  });
  return `${common}\nstart_services() {\n  local SERVICE_UID file attempt\n  SERVICE_UID="$(id -u stll-cloud)"\n  [[ -d "$STATE" && ! -L "$STATE" && "$(stat -c '%u' "$STATE")" == 0 ]] || fail "Invalid cloud service state directory"\n${bodies.join("")}\n}\n`;
};
