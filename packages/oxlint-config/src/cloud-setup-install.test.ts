/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import policy from "../toolchain.json";
import { renderCloudServiceInstall } from "./cloud-setup-install";
import { cloudServices } from "./cloud-setup-schema";
import { parseToolchainPolicy } from "./toolchain-schema";

const fragment = renderCloudServiceInstall({
  ...parseToolchainPolicy(policy),
  services: [],
})
  .replaceAll("/var/lock/stll-cloud-apt.lock", '"$FIXTURE_LOCK"')
  .replaceAll("/usr/sbin/policy-rc.d", '"$FIXTURE_POLICY"');

const runInstall = (
  directory: string,
  exitCode: number,
  offlineExitCode = 0,
  packages: string[] = ["fixture-package"],
) => {
  expect(fragment).not.toContain("/var/lock/");
  expect(fragment).not.toContain("/usr/sbin/");
  return Bun.spawnSync(
    [
      "bash",
      "-eu",
      "-c",
      `
fail() { printf '%s\\n' "$1" >&2; exit 1; }
flock() { [[ "$*" == '-x -w 120 8' ]]; }
apt_network() {
  [[ "$DEBIAN_FRONTEND" == noninteractive ]]
  [[ "$(cat "$FIXTURE_POLICY")" == $'#!/bin/sh\\nexit 101' ]]
  [[ -x "$FIXTURE_POLICY" ]]
  printf 'network:%s\n' "$*" >> "$FIXTURE_CALLS"
  return "$FIXTURE_EXIT"
}
apt-get() {
  [[ "$DEBIAN_FRONTEND" == noninteractive ]]
  [[ "$(cat "$FIXTURE_POLICY")" == $'#!/bin/sh\nexit 101' ]]
  printf 'offline:%s\n' "$*" >> "$FIXTURE_CALLS"
  return "$FIXTURE_OFFLINE_EXIT"
}
${fragment}
apt_install "$@"
`,
      "install",
      ...packages,
    ],
    {
      env: {
        ...process.env,
        TMPDIR: directory,
        FIXTURE_POLICY: join(directory, "policy-rc.d"),
        FIXTURE_LOCK: join(directory, "apt.lock"),
        FIXTURE_CALLS: join(directory, "apt.calls"),
        FIXTURE_EXIT: String(exitCode),
        FIXTURE_OFFLINE_EXIT: String(offlineExitCode),
      },
    },
  );
};

test("package installation restores policy bytes and mode across success, failure and timeout", () => {
  const original = "#!/bin/sh\n# Existing host policy\nexit 0\n";
  for (const exitCode of [0, 17, 124]) {
    for (const existing of [true, false]) {
      const directory = mkdtempSync(join(tmpdir(), "cloud-apt-test-"));
      try {
        const file = join(directory, "policy-rc.d");
        if (existing) writeFileSync(file, original, { mode: 0o640 });
        const result = runInstall(directory, exitCode);
        expect(result.stderr.toString()).toBe("");
        expect(result.exitCode).toBe(exitCode);
        // Only the download runs under the network deadline; a failed
        // download never reaches the offline install.
        expect(readFileSync(join(directory, "apt.calls"), "utf8")).toBe(
          "network:install -y --no-install-recommends --download-only fixture-package\n" +
            (exitCode === 0
              ? "offline:install -y --no-install-recommends --no-download fixture-package\n"
              : ""),
        );
        expect(existsSync(file)).toBe(existing);
        if (existing) {
          expect(readFileSync(file, "utf8")).toBe(original);
          expect(statSync(file).mode & 0o777).toBe(0o640);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
});

test("package installation refuses symlink policies before invoking apt", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-apt-test-"));
  try {
    const target = join(directory, "original");
    const file = join(directory, "policy-rc.d");
    writeFileSync(target, "original policy\n", { mode: 0o640 });
    symlinkSync(target, file);
    const result = runInstall(directory, 0);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Unsupported service-start policy symlink",
    );
    expect(existsSync(join(directory, "apt.calls"))).toBe(false);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("original policy\n");
    expect(statSync(target).mode & 0o777).toBe(0o640);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const pgdgFragment = renderCloudServiceInstall({
  ...parseToolchainPolicy(policy),
  services: ["postgres"],
});

test("service installation uses shared bounded network helpers for every download and package operation", () => {
  for (let mask = 0; mask < 2 ** cloudServices.length; mask += 1) {
    const services = cloudServices.filter(
      (_, index) => (mask & (1 << index)) !== 0,
    );
    const rendered = renderCloudServiceInstall({
      ...parseToolchainPolicy(policy),
      services,
    });
    // The only raw apt-get is the offline install, which cannot download.
    const offline =
      '  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --no-download "$@"\n';
    expect(rendered.split(offline)).toHaveLength(2);
    expect(rendered.replace(offline, "")).not.toMatch(
      /\b(?:curl|wget|apt-get)\b/,
    );
    expect(rendered).toContain(
      'DEBIAN_FRONTEND=noninteractive apt_network install -y --no-install-recommends --download-only "$@"\n  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --no-download "$@"\n)',
    );
    expect(rendered).not.toContain("apt_network update");
    const refreshes = [...rendered.matchAll(/^ *apt_refresh_for (.+)\n *apt_install (.+)$/gm)];
    expect(refreshes.length).toBe(services.length);
    for (const [, refreshed, installed] of refreshes)
      expect(refreshed).toBe(installed);
    expect(
      rendered.includes(
        'download_file https://www.postgresql.org/media/keys/ACCC4CF8.asc "$key" 45',
      ),
    ).toBe(services.includes("postgres"));
    for (const artifact of ["server", "tools"])
      expect(
        rendered.includes(
          `download_file "$${artifact}_url" "$scratch/valkey-${artifact}.deb" 120`,
        ),
      ).toBe(services.includes("valkey"));
  }
});

test("service provisioning passes explicit download deadlines and stops before package installation on failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-download-test-"));
  try {
    for (const service of cloudServices) {
      for (const arch of ["amd64", "arm64"] as const) {
        const calls = join(directory, "download.calls");
        const isolated = renderCloudServiceInstall({
          ...parseToolchainPolicy(policy),
          services: [service],
        }).replaceAll(
          `/usr/lib/postgresql/${policy.postgres}/bin`,
          "$FIXTURE_PG_BIN",
        );
        const result = Bun.spawnSync(
          [
            "bash",
            "-eu",
            "-c",
            `
fail() { printf '%s\\n' "$1" >&2; exit 1; }
${isolated}
id() { return 0; }
service_account_ready() { :; }
pgdg_sources_ready() { PGDG_SOURCE_STATE=missing; }
valkey-server() { return 1; }
valkey-cli() { return 1; }
mktemp() {
  if [[ "$*" == -d ]]; then
    mkdir -p "$FIXTURE_TMP/scratch"
    printf '%s\\n' "$FIXTURE_TMP/scratch"
  else printf '%s\\n' "$FIXTURE_TMP/signing-key"; fi
}
download_file() { printf '%s\\t%s\\t%s' "$1" "$2" "$3" > "$FIXTURE_CALLS"; exit 73; }
apt_network() { fail 'Unexpected package operation after failed download'; }
install_services
`,
          ],
          {
            env: {
              ...process.env,
              ARCH: arch,
              TMPDIR: directory,
              FIXTURE_TMP: directory,
              FIXTURE_CALLS: calls,
              FIXTURE_PG_BIN: join(directory, "missing-bin"),
            },
          },
        );
        expect(result.exitCode).toBe(73);
        expect(result.stderr.toString()).toBe("");
        const [url, output, deadline] = readFileSync(calls, "utf8").split("\t");
        expect(url).toBe(
          service === "postgres"
            ? "https://www.postgresql.org/media/keys/ACCC4CF8.asc"
            : policy.valkeyArtifacts[arch].server.url,
        );
        expect(output?.startsWith(`${directory}/`)).toBe(true);
        expect(deadline).toBe(service === "postgres" ? "45" : "120");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

type SourcePreflightOptions = {
  directory: string;
  files: string[];
  fingerprints?: readonly string[];
};

const runSourcePreflight = ({
  directory,
  files,
  fingerprints = ["B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8"],
}: SourcePreflightOptions) =>
  Bun.spawnSync(
    [
      "bash",
      "-euo",
      "pipefail",
      "-c",
      `fail() { printf '%s\\n' "$1" >&2; exit 1; }\ngpg() { while IFS= read -r fingerprint; do printf 'pub:::::::::\\nfpr:::::::::%s:\\n' "$fingerprint"; done <<< "$FIXTURE_FINGERPRINTS"; }\n${pgdgFragment}\npgdg_sources_ready "$MANAGED_SOURCE" "$@"\nprintf '%s' "$PGDG_SOURCE_STATE"`,
      "--",
      ...files,
    ],
    {
      env: {
        ...process.env,
        MANAGED_SOURCE: join(directory, "stll-pgdg.list"),
        FIXTURE_FINGERPRINTS: fingerprints.join("\n"),
      },
    },
  );

test("PGDG preflight distinguishes active list and folded deb822 sources from comments and disabled stanzas", () => {
  const fixtures = [
    {
      name: "commented.list",
      text: "# deb https://apt.postgresql.org/pub/repos/apt noble-pgdg main\n",
      conflict: false,
    },
    {
      name: "ubuntu.list",
      text: "deb https://archive.ubuntu.com/ubuntu noble main\n",
      conflict: false,
    },
    {
      name: "active.list",
      text: "deb [signed-by=/other/key] https://apt.postgresql.org/pub/repos/apt noble-pgdg main\n",
      conflict: false,
    },
    {
      name: "source.list",
      text: "  deb-src http://APT.POSTGRESQL.ORG:80/pub/repos/apt noble-pgdg main # comment\n",
      conflict: true,
    },
    {
      name: "folded.sources",
      text: "Types: deb\nURIs: https://archive.ubuntu.com/ubuntu\n https://apt.postgresql.org/pub/repos/apt\nSuites: noble-pgdg\nSigned-By:\n /other/key\nComponents: main\n",
      conflict: false,
    },
    {
      name: "enabled.sources",
      text: "Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nEnabled: yes\n",
      conflict: true,
    },
    {
      name: "disabled.sources",
      text: "Types: deb\nURIs:\n https://apt.postgresql.org/pub/repos/apt\nEnabled:\n no\n\nTypes: deb\nURIs: https://archive.ubuntu.com/ubuntu\n",
      conflict: false,
    },
    {
      name: "commented.sources",
      text: "# URIs: https://apt.postgresql.org/pub/repos/apt\nTypes: deb\nURIs: https://archive.ubuntu.com/ubuntu\n",
      conflict: false,
    },
    {
      name: "mixed.sources",
      text: "URIs: https://apt.postgresql.org/pub/repos/apt\nEnabled: no\n\nURIs: https://apt.postgresql.org/pub/repos/apt\n",
      conflict: true,
    },
  ];
  for (const { name, text, conflict } of fixtures) {
    const directory = mkdtempSync(join(tmpdir(), "cloud-pgdg-test-"));
    try {
      const file = join(directory, name);
      writeFileSync(file, text);
      const result = runSourcePreflight({
        directory,
        files: [join(directory, "missing.list"), file],
      });
      expect(result.exitCode).toBe(conflict ? 1 : 0);
      if (conflict) expect(result.stderr.toString()).toContain(file);
      else expect(result.stderr.toString()).toBe("");
      expect(readFileSync(file, "utf8")).toBe(text);
      expect(existsSync(join(directory, "stll-pgdg.list"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("PGDG preflight reuses verified managed sources and precedes provisioning", () => {
  const canonical =
    /printf '%s\\n' '([^']+)' > \/etc\/apt\/sources\.list\.d\/stll-pgdg\.list/
      .exec(pgdgFragment)
      ?.at(1);
  expect(canonical).toBeDefined();
  if (canonical === undefined) throw new Error("Missing canonical PGDG source");
  expect(pgdgFragment).toContain(
    `printf '%s\\n' '${canonical}' > /etc/apt/sources.list.d/stll-pgdg.list`,
  );
  expect(
    pgdgFragment.indexOf(
      "pgdg_sources_ready /etc/apt/sources.list.d/stll-pgdg.list",
    ),
  ).toBeLessThan(pgdgFragment.indexOf("download_file "));
  for (const text of [
    `${canonical}\n`,
    "# existing unmanaged content\n",
    `${canonical}\n# extra content\n`,
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "cloud-pgdg-test-"));
    try {
      const file = join(directory, "stll-pgdg.list");
      writeFileSync(file, text);
      const result = runSourcePreflight({ directory, files: [file] });
      expect(result.exitCode).toBe(text.startsWith(canonical) ? 0 : 1);
      if (result.exitCode === 0) expect(result.stdout.toString()).toBe("reuse");
      expect(readFileSync(file, "utf8")).toBe(text);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const directory = mkdtempSync(join(tmpdir(), "cloud-pgdg-test-"));
  try {
    const target = join(directory, "original.list");
    const file = join(directory, "stll-pgdg.list");
    writeFileSync(target, `${canonical}\n`);
    symlinkSync(target, file);
    const result = runSourcePreflight({ directory, files: [file] });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Managed PGDG source must not be a symlink",
    );
    expect(readFileSync(target, "utf8")).toBe(`${canonical}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a complete preinstalled PostgreSQL toolchain requires no PGDG source changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-pg-ready-test-"));
  try {
    const binaries = join(directory, "bin");
    mkdirSync(binaries);
    for (const binary of ["postgres", "initdb", "pg_ctl", "psql", "createdb"])
      writeFileSync(
        join(binaries, binary),
        binary === "postgres"
          ? `#!/bin/sh\nprintf '%s\\n' 'postgres (PostgreSQL) ${policy.postgres}.6'\n`
          : "#!/bin/sh\nexit 0\n",
        { mode: 0o755 },
      );
    const isolated = pgdgFragment.replaceAll(
      `/usr/lib/postgresql/${policy.postgres}/bin`,
      "$FIXTURE_PG_BIN",
    );
    const result = Bun.spawnSync(
      [
        "bash",
        "-eu",
        "-c",
        `
fail() { printf '%s\\n' "$1" >&2; exit 1; }
${isolated}
id() { return 0; }
service_account_ready() { :; }
pgdg_sources_ready() { echo 'unexpected source preflight' >&2; exit 90; }
download_file() { echo 'unexpected network' >&2; exit 91; }
apt_network() { echo 'unexpected apt' >&2; exit 92; }
install_services
`,
      ],
      { env: { ...process.env, FIXTURE_PG_BIN: binaries } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PGDG reuse requires the verified signing fingerprint and consistent keyring bindings", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-pgdg-keys-test-"));
  try {
    const first = join(directory, "first.list");
    const second = join(directory, "second.sources");
    const keyring = join(directory, "pgdg.asc");
    writeFileSync(keyring, "fixture keyring\n");
    writeFileSync(
      first,
      `deb [signed-by=${keyring}] https://apt.postgresql.org/pub/repos/apt noble-pgdg main\n`,
    );
    writeFileSync(
      second,
      `Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: noble-pgdg\nSigned-By: ${keyring}\n`,
    );
    const good = runSourcePreflight({ directory, files: [first, second] });
    expect(good.exitCode).toBe(0);
    expect(good.stdout.toString()).toBe("reuse");
    expect(existsSync(join(directory, "stll-pgdg.list"))).toBe(false);
    const bad = runSourcePreflight({
      directory,
      files: [first],
      fingerprints: ["0".repeat(40)],
    });
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain(
      `PGDG Signed-By fingerprint mismatch: ${first}`,
    );
    const extraKey = runSourcePreflight({
      directory,
      files: [first],
      fingerprints: [
        "B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8",
        "0".repeat(40),
      ],
    });
    expect(extraKey.exitCode).toBe(1);
    expect(extraKey.stderr.toString()).toContain(
      `PGDG Signed-By fingerprint mismatch: ${first}`,
    );
    writeFileSync(
      second,
      `Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: noble-pgdg\nSigned-By: ${keyring}#different\n`,
    );
    const conflicting = runSourcePreflight({
      directory,
      files: [first, second],
    });
    expect(conflicting.exitCode).toBe(1);
    expect(conflicting.stderr.toString()).toContain(
      `Conflicting PGDG Signed-By keyrings: ${second}`,
    );
    writeFileSync(
      first,
      `deb [signed-by=${keyring}] https://apt.postgresql.org/pub/repos/apt jammy-pgdg main\n`,
    );
    const suite = runSourcePreflight({ directory, files: [first] });
    expect(suite.exitCode).toBe(1);
    expect(suite.stderr.toString()).toContain(first);
    expect(existsSync(join(directory, "stll-pgdg.list"))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verified PGDG sources cannot enable APT trust overrides", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-pgdg-trust-test-"));
  try {
    const list = join(directory, "pgdg.list");
    const deb822 = join(directory, "pgdg.sources");
    const keyring = join(directory, "pgdg.asc");
    for (const option of [
      "trusted",
      "allow-insecure",
      "allow-weak",
      "allow-downgrade-to-insecure",
    ]) {
      const text = `deb [signed-by=${keyring} ${option}=yes] https://apt.postgresql.org/pub/repos/apt noble-pgdg main\n`;
      writeFileSync(list, text);
      const result = runSourcePreflight({ directory, files: [list] });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(
        `PGDG source enables an unsafe trust override: ${list}`,
      );
      expect(readFileSync(list, "utf8")).toBe(text);
    }
    writeFileSync(
      deb822,
      `Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: noble-pgdg\nSigned-By: ${keyring}\nTrusted:\n yes\n`,
    );
    const enabled = runSourcePreflight({ directory, files: [deb822] });
    expect(enabled.exitCode).toBe(1);
    expect(enabled.stderr.toString()).toContain(
      `PGDG source enables an unsafe trust override: ${deb822}`,
    );
    writeFileSync(
      deb822,
      `Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: noble-pgdg\nSigned-By: ${keyring}\nTrusted:\n no\n`,
    );
    const disabled = runSourcePreflight({ directory, files: [deb822] });
    expect(disabled.exitCode).toBe(0);
    expect(disabled.stdout.toString()).toBe("reuse");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline package configuration failures propagate and still restore the policy", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-apt-test-"));
  try {
    const result = runInstall(directory, 0, 100);
    expect(result.exitCode).toBe(100);
    expect(readFileSync(join(directory, "apt.calls"), "utf8")).toBe(
      "network:install -y --no-install-recommends --download-only fixture-package\n" +
        "offline:install -y --no-install-recommends --no-download fixture-package\n",
    );
    expect(existsSync(join(directory, "policy-rc.d"))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local package archives install in one bounded step because apt cannot pre-download them", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-apt-test-"));
  try {
    const result = runInstall(directory, 0, 0, ["/tmp/a.deb", "/tmp/b.deb"]);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(directory, "apt.calls"), "utf8")).toBe(
      "network:install -y --no-install-recommends /tmp/a.deb /tmp/b.deb\n",
    );
    expect(existsSync(join(directory, "policy-rc.d"))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
