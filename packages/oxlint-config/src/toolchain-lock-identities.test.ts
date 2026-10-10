import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";

import { compilerPackages } from "./compiler-packages";
import { detectToolchainChanges } from "./toolchain-changed";
import { parseChangedLock } from "./toolchain-changed-locks";
import { runSelectedTypecheckParity } from "./typecheck-parity-selection";

const integrity = (value: string) =>
  `sha512-${Buffer.alloc(64, value).toString("base64")}`;
const npmLock = (
  metadata: Record<string, unknown>,
  dependency = "typescript",
) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { devDependencies: { [dependency]: "7.0.2" } },
      [`node_modules/${dependency}`]: { version: "7.0.2", ...metadata },
    },
  });
const pnpmLock = (metadata: Record<string, unknown>, name = "typescript") =>
  stringify({
    lockfileVersion: "9.0",
    importers: {
      ".": {
        devDependencies: { [name]: { specifier: "7.0.2", version: "7.0.2" } },
      },
    },
    packages: { [`${name}@7.0.2`]: metadata },
  });
const bunLock = (digest: string, name = "typescript") =>
  JSON.stringify({
    lockfileVersion: 1,
    workspaces: { "": { devDependencies: { [name]: "7.0.2" } } },
    packages: {
      [name]: [`${name}@7.0.2`, "", { bin: { tsc: "bin/tsc" } }, digest],
    },
  });
const yarnLock = (checksum: string, name = "typescript") =>
  stringify({
    __metadata: { version: 8, cacheKey: "10c0" },
    [`${name}@npm:7.0.2`]: {
      version: "7.0.2",
      resolution: `${name}@npm:7.0.2`,
      checksum,
    },
  });
const single = (file: string, text: string) => {
  const resolution = parseChangedLock({ file, text }).resolutions.at(0);
  if (!resolution) throw new Error("Expected compiler resolution");
  return resolution;
};

for (const name of Object.values(compilerPackages))
  test(`${name} lock identity includes source integrity across supported formats`, () => {
    for (const [file, before, after] of [
      [
        "package-lock.json",
        npmLock({ integrity: integrity("first") }, name),
        npmLock({ integrity: integrity("second") }, name),
      ],
      [
        "pnpm-lock.yaml",
        pnpmLock({ resolution: { integrity: integrity("first") } }, name),
        pnpmLock({ resolution: { integrity: integrity("second") } }, name),
      ],
      [
        "bun.lock",
        bunLock(integrity("first"), name),
        bunLock(integrity("second"), name),
      ],
      [
        "yarn.lock",
        yarnLock("a".repeat(128), name),
        yarnLock("b".repeat(128), name),
      ],
    ]) {
      if (!file || !before || !after)
        throw new Error("Invalid identity fixture");
      const previous = single(file, before);
      const current = single(file, after);
      expect(current.version).toBe(previous.version);
      expect(current.identity).not.toBe(previous.identity);
      expect(current.sourceProof.type).toBe("immutable");
      expect(single(file, after).identity).toBe(current.identity);
    }
  });

test("npm aliases retain actual compiler identity", () => {
  const before = single(
    "package-lock.json",
    npmLock(
      {
        name: "typescript",
        resolved: "file:compiler-a.tgz",
        integrity: integrity("first"),
      },
      "compiler",
    ),
  );
  const after = single(
    "package-lock.json",
    npmLock(
      {
        name: "typescript",
        resolved: "file:compiler-b.tgz",
        integrity: integrity("first"),
      },
      "compiler",
    ),
  );
  expect(after.name).toBe("typescript");
  expect(after.dependency).toBe("compiler");
  expect(after.identity).not.toBe(before.identity);
});

test("Yarn Classic compiler source and checksum are retained", () => {
  const classic = (hash: string) =>
    `# yarn lockfile v1\n\ntypescript@7.0.2:\n  version "7.0.2"\n  resolved "https://registry.yarnpkg.com/typescript/-/typescript-7.0.2.tgz"\n  integrity ${integrity(hash)}\n`;
  expect(single("yarn.lock", classic("first")).identity).not.toBe(
    single("yarn.lock", classic("second")).identity,
  );
});

test("compiler source proof ignores unrelated nested dependency integrity", () => {
  expect(() =>
    parseChangedLock({
      file: "package-lock.json",
      text: npmLock({
        resolved: "file:compiler",
        dependencies: { ordinary: { integrity: integrity("ordinary") } },
      }),
    }),
  ).toThrow("immutable identity");
});

for (const resolved of [
  "file:../compiler",
  "git+https://example.test/compiler.git#main",
  "https://example.test/compiler.tgz",
])
  test(`unidentified compiler source ${resolved} fails closed`, () => {
    expect(() =>
      parseChangedLock({
        file: "package-lock.json",
        text: npmLock({ resolved }),
      }),
    ).toThrow("immutable identity");
  });

test("compiler link directory fails closed even with a package version", () => {
  expect(() =>
    parseChangedLock({
      file: "package-lock.json",
      text: npmLock({ link: true, resolved: "../compiler" }),
    }),
  ).toThrow("immutable identity");
});

test("full Git commit is immutable source evidence", () => {
  const result = single(
    "package-lock.json",
    npmLock({
      resolved: `git+https://example.test/compiler.git#${"a".repeat(40)}`,
    }),
  );
  expect(result.sourceProof.type).toBe("immutable");
});

test("object key order does not change compiler identity", () => {
  const before = npmLock({
    integrity: integrity("same"),
    resolved: "file:compiler.tgz",
  });
  const after = npmLock({
    resolved: "file:compiler.tgz",
    integrity: integrity("same"),
  });
  expect(single("package-lock.json", before).identity).toBe(
    single("package-lock.json", after).identity,
  );
});

const withCommittedLocks = async ({
  before,
  after,
  exercise,
  file = "package-lock.json",
  manager = "npm@11.20.0",
  beforeSpecifier = "7.0.2",
  afterSpecifier = beforeSpecifier,
}: {
  before: string;
  after: string;
  file?: string;
  manager?: string;
  beforeSpecifier?: string;
  afterSpecifier?: string;
  exercise: (options: { repo: string; since: string }) => Promise<void>;
}) => {
  const repo = mkdtempSync(path.join(tmpdir(), "toolchain-lock-identity-"));
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = () => {
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ]);
    return git(["rev-parse", "HEAD"]);
  };
  try {
    git(["init", "-q"]);
    writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({
        private: true,
        packageManager: manager,
        devDependencies: { typescript: beforeSpecifier },
      }),
    );
    writeFileSync(path.join(repo, file), before);
    const since = commit();
    writeFileSync(path.join(repo, file), after);
    writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({
        private: true,
        packageManager: manager,
        devDependencies: { typescript: afterSpecifier },
      }),
    );
    commit();
    await exercise({ repo, since });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
};

for (const source of ["file", "git", "integrity"])
  test(`committed same-version compiler ${source} identity changes run parity`, async () => {
    const lock = (next: boolean) => {
      if (source === "git")
        return npmLock({
          resolved: `git+https://example.test/compiler.git#${(next ? "b" : "a").repeat(40)}`,
        });
      return npmLock({
        resolved: `file:compiler-${source === "file" && next ? "b" : "a"}.tgz`,
        integrity: integrity(source === "integrity" && next ? "next" : "same"),
      });
    };
    await withCommittedLocks({
      before: lock(false),
      after: lock(true),
      exercise: async ({ repo, since }) => {
        const result = await detectToolchainChanges({ repo, since });
        expect(result.status).toBe("compared");
        expect(result.tools).toContain("typescript");
        let runs = 0;
        await runSelectedTypecheckParity({
          repo,
          since,
          run: async () => {
            runs++;
            return true;
          },
          output: () => {},
        });
        expect(runs).toBe(1);
      },
    });
  });

test("identical committed compiler source identity skips parity", async () => {
  const lock = npmLock({
    resolved: "file:compiler.tgz",
    integrity: integrity("same"),
  });
  await withCommittedLocks({
    before: lock,
    after: lock,
    exercise: async ({ repo, since }) => {
      expect(await detectToolchainChanges({ repo, since })).toMatchObject({
        status: "compared",
        changed: false,
        tools: [],
      });
      let runs = 0;
      await runSelectedTypecheckParity({
        repo,
        since,
        run: async () => {
          runs++;
          return true;
        },
        output: () => {},
      });
      expect(runs).toBe(0);
    },
  });
});

test("committed compiler source without byte identity runs parity fail closed", async () => {
  await withCommittedLocks({
    before: npmLock({ integrity: integrity("before") }),
    after: npmLock({ resolved: "file:compiler" }),
    exercise: async ({ repo, since }) => {
      expect(await detectToolchainChanges({ repo, since })).toMatchObject({
        status: "unreadable",
        changed: true,
      });
      let runs = 0;
      await runSelectedTypecheckParity({
        repo,
        since,
        run: async () => {
          runs++;
          return true;
        },
        output: () => {},
      });
      expect(runs).toBe(1);
    },
  });
});

test("malformed digest strings are not immutable source evidence", () => {
  for (const digest of [
    "sha512-old",
    "sha512-YQ==",
    "sha256-YQ==",
    "sha512-" + "!".repeat(88),
  ])
    expect(() =>
      parseChangedLock({
        file: "package-lock.json",
        text: npmLock({ resolved: "file:compiler.tgz", integrity: digest }),
      }),
    ).toThrow("immutable identity");
});

for (const [file, manager, before, after] of [
  [
    "bun.lock",
    "bun@1.4.3",
    bunLock(integrity("first")),
    bunLock(integrity("second")),
  ],
  [
    "pnpm-lock.yaml",
    "pnpm@12.9.1",
    pnpmLock({
      resolution: {
        integrity: integrity("first"),
        tarball: "https://example.test/compiler.tgz",
      },
    }),
    pnpmLock({
      resolution: {
        integrity: integrity("second"),
        tarball: "https://example.test/compiler.tgz",
      },
    }),
  ],
  [
    "yarn.lock",
    "yarn@4.10.3",
    yarnLock("a".repeat(128)),
    yarnLock("b".repeat(128)),
  ],
]) {
  if (!file || !manager || !before || !after)
    throw new Error("Invalid committed identity fixture");
  test(`${file} committed source identities are compared with unchanged versions`, async () => {
    for (const changed of [false, true])
      await withCommittedLocks({
        file,
        manager,
        before,
        after: changed ? after : before,
        exercise: async ({ repo, since }) => {
          const result = await detectToolchainChanges({ repo, since });
          expect(result.status).toBe("compared");
          expect(result.changed).toBe(changed);
          expect(result.tools.includes("typescript")).toBe(changed);
        },
      });
  });
}

test("pnpm compiler Git and directory metadata fail closed without evidence", () => {
  for (const resolution of [
    { type: "git", repo: "https://example.test/compiler" },
    { directory: "../compiler" },
  ])
    expect(() =>
      parseChangedLock({
        file: "pnpm-lock.yaml",
        text: pnpmLock({ resolution }),
      }),
    ).toThrow("immutable identity");
});

test("committed manifest compiler source changes are retained with an unchanged lock hash", async () => {
  const lock = npmLock({ integrity: integrity("same") });
  await withCommittedLocks({
    before: lock,
    after: lock,
    beforeSpecifier: "file:compiler-a.tgz",
    afterSpecifier: "file:compiler-b.tgz",
    exercise: async ({ repo, since }) => {
      const result = await detectToolchainChanges({ repo, since });
      expect(result.status).toBe("compared");
      expect(result.tools).toContain("typescript");
    },
  });
});

test("manifest compiler directory cannot borrow a minimal registry lock as source evidence", async () => {
  const lock = npmLock({});
  await withCommittedLocks({
    before: lock,
    after: lock,
    afterSpecifier: "file:../compiler",
    exercise: async ({ repo, since }) => {
      expect(await detectToolchainChanges({ repo, since })).toMatchObject({
        status: "unreadable",
        changed: true,
      });
    },
  });
});

for (const resolved of [
  "git@example.test:compiler.git#main",
  "builder@example.test:compiler#branch",
])
  test(`compiler SCP source ${resolved} without commit fails closed`, () => {
    expect(() =>
      parseChangedLock({
        file: "package-lock.json",
        text: npmLock({ resolved }),
      }),
    ).toThrow("immutable identity");
  });

test("pnpm compiler descriptor protocols cannot borrow a registry proof", () => {
  for (const descriptor of [
    "typescript@https://example.test/compiler.tgz",
    "typescript@git@example.test:compiler.git#main",
  ])
    expect(() =>
      parseChangedLock({
        file: "pnpm-lock.yaml",
        text: stringify({
          lockfileVersion: "9.0",
          importers: { ".": {} },
          packages: { [descriptor]: { version: "7.0.2" } },
        }),
      }),
    ).toThrow("immutable identity");
});

test("compiler directory protocols cannot borrow archive integrity or unrelated commits", () => {
  const digest = integrity("archive");
  for (const metadata of [
    { resolved: "file:../compiler", integrity: digest },
    { resolved: "file:../compiler", commit: "a".repeat(40) },
    { resolved: "file:../compiler", integrity: digest, commit: "a".repeat(40) },
    { resolved: "../compiler", link: true, integrity: digest },
    { resolved: "workspace:*", integrity: digest },
  ])
    expect(() =>
      parseChangedLock({ file: "package-lock.json", text: npmLock(metadata) }),
    ).toThrow("immutable identity");
  for (const resolution of [
    { type: "directory", directory: "../compiler", integrity: digest },
    { directory: "../compiler", integrity: digest, commit: "a".repeat(40) },
  ])
    expect(() =>
      parseChangedLock({
        file: "pnpm-lock.yaml",
        text: pnpmLock({ resolution }),
      }),
    ).toThrow("immutable identity");
  const berryDirectory = stringify({
    __metadata: { version: 8 },
    "typescript@file:../compiler": {
      version: "7.0.2",
      resolution: "typescript@file:../compiler",
      checksum: "a".repeat(128),
    },
  });
  expect(() =>
    parseChangedLock({ file: "yarn.lock", text: berryDirectory }),
  ).toThrow("immutable identity");
  const bunDirectory = JSON.stringify({
    lockfileVersion: 1,
    workspaces: { "": {} },
    packages: { typescript: ["typescript@file:../compiler", "", {}, digest] },
  });
  expect(() =>
    parseChangedLock({ file: "bun.lock", text: bunDirectory }),
  ).toThrow("immutable identity");
});

test("local compiler archives require archive integrity rather than unrelated Git commits", () => {
  for (const archive of ["file:compiler.tgz", "file:compiler.tar.gz"])
    expect(
      single(
        "package-lock.json",
        npmLock({ resolved: archive, integrity: integrity("archive") }),
      ).sourceProof.type,
    ).toBe("immutable");
  expect(() =>
    parseChangedLock({
      file: "package-lock.json",
      text: npmLock({ resolved: "file:compiler.tgz", commit: "a".repeat(40) }),
    }),
  ).toThrow("immutable identity");
  expect(
    single("package-lock.json", npmLock({ commit: "a".repeat(40) })).sourceProof
      .type,
  ).toBe("registry");
});

const peerSnapshotLock = (
  peerVersion: string,
  patchVersion: string,
  unrelatedVersion = "1.0.0",
) =>
  stringify({
    lockfileVersion: "9.0",
    importers: {
      ".": {
        devDependencies: {
          typescript: { specifier: "7.0.2", version: "7.0.2(peer@1.0.0)" },
        },
      },
    },
    packages: {
      "typescript@7.0.2": { resolution: { integrity: integrity("same") } },
    },
    snapshots: {
      "typescript@7.0.2(peer@1.0.0)": { dependencies: { peer: peerVersion } },
      "typescript@7.0.2(patch_hash=stable)(peer@2.0.0)": {
        optionalDependencies: { helper: patchVersion },
      },
      "ordinary@1.0.0(peer@1.0.0)": {
        dependencies: { peer: unrelatedVersion },
      },
      "typescript@7.0.3(peer@1.0.0)": {
        dependencies: { peer: unrelatedVersion },
      },
    },
  });

test("pnpm compiler identity retains every peer and patch snapshot variant", () => {
  const before = single("pnpm-lock.yaml", peerSnapshotLock("1.0.0", "1.0.0"));
  expect(
    single("pnpm-lock.yaml", peerSnapshotLock("1.0.1", "1.0.0")).identity,
  ).not.toBe(before.identity);
  expect(
    single("pnpm-lock.yaml", peerSnapshotLock("1.0.0", "1.0.1")).identity,
  ).not.toBe(before.identity);
  expect(
    single("pnpm-lock.yaml", peerSnapshotLock("1.0.0", "1.0.0", "1.0.1"))
      .identity,
  ).toBe(before.identity);
});

test("committed pnpm peer snapshot edits run parity with compiler release unchanged", async () => {
  await withCommittedLocks({
    file: "pnpm-lock.yaml",
    manager: "pnpm@12.9.1",
    before: peerSnapshotLock("1.0.0", "1.0.0"),
    after: peerSnapshotLock("1.0.1", "1.0.0"),
    exercise: async ({ repo, since }) => {
      const result = await detectToolchainChanges({ repo, since });
      expect(result.status).toBe("compared");
      expect(result.tools).toContain("typescript");
      let runs = 0;
      await runSelectedTypecheckParity({
        repo,
        since,
        run: async () => {
          runs++;
          return true;
        },
        output: () => {},
      });
      expect(runs).toBe(1);
    },
  });
});

for (const location of ["../local-compiler", "packages/compiler", ""])
  test(`canonical compiler directory metadata at ${location || "."} fails closed`, () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/compiler": { link: true, resolved: location || "." },
        [location]: {
          name: "typescript",
          version: "7.0.2",
          integrity: integrity("unrelated archive"),
        },
      },
    });
    expect(() => parseChangedLock({ file: "package-lock.json", text })).toThrow(
      "Compiler directory lock entry has no tracked byte identity",
    );
  });

test("ordinary local directory package metadata remains outside compiler inventory", () => {
  const text = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "node_modules/library": { link: true, resolved: "../library" },
      "../library": { name: "ordinary-library", version: "1.0.0" },
    },
  });
  expect(
    parseChangedLock({ file: "package-lock.json", text }).resolutions,
  ).toEqual([]);
});

test("Git commit evidence accepts exactly SHA-1 or SHA-256 lengths", () => {
  for (const length of [39, 40, 41, 63, 64, 65]) {
    const commit = "a".repeat(length);
    for (const metadata of [
      { resolved: `git+https://example.test/compiler.git#${commit}` },
      { resolved: "git+https://example.test/compiler.git", commit },
    ]) {
      const text = npmLock(metadata);
      if (length === 40 || length === 64)
        expect(single("package-lock.json", text).sourceProof.type).toBe(
          "immutable",
        );
      else
        expect(() =>
          parseChangedLock({ file: "package-lock.json", text }),
        ).toThrow("immutable identity");
    }
  }
});

test("mutable Git branches cannot borrow archive integrity or cache checksums", () => {
  expect(() =>
    parseChangedLock({
      file: "package-lock.json",
      text: npmLock({
        resolved: "git+https://example.test/compiler.git#main",
        integrity: integrity("archive"),
      }),
    }),
  ).toThrow("immutable identity");
  expect(() =>
    parseChangedLock({
      file: "pnpm-lock.yaml",
      text: pnpmLock({
        resolution: {
          type: "git",
          repo: "https://example.test/compiler.git#main",
          integrity: integrity("archive"),
        },
      }),
    }),
  ).toThrow("immutable identity");
  const text = stringify({
    __metadata: { version: 8 },
    "typescript@git+https://example.test/compiler.git#main": {
      version: "7.0.2",
      resolution: "typescript@git+https://example.test/compiler.git#main",
      checksum: "a".repeat(128),
    },
  });
  expect(() => parseChangedLock({ file: "yarn.lock", text })).toThrow(
    "immutable identity",
  );
});

test("Yarn compiler patch protocols require tracked patch contents despite cache checksums", () => {
  for (const name of ["typescript", "@typescript/native", "bun-types"])
    for (const dependency of [name, "compiler"]) {
      const descriptor = `${dependency}@patch:${name}@npm%3A7.0.2#./compiler.patch`;
      const text = stringify({
        __metadata: { version: 8 },
        [descriptor]: {
          version: "7.0.2",
          resolution: descriptor,
          checksum: "a".repeat(128),
        },
      });
      expect(() => parseChangedLock({ file: "yarn.lock", text })).toThrow(
        "Yarn compiler patch identity requires tracked patch bytes",
      );
    }
  const resolutionOnly = stringify({
    __metadata: { version: 8 },
    "typescript@npm:7.0.2": {
      version: "7.0.2",
      resolution: "typescript@patch:typescript@npm%3A7.0.2#./compiler.patch",
      checksum: "a".repeat(128),
    },
  });
  expect(() =>
    parseChangedLock({ file: "yarn.lock", text: resolutionOnly }),
  ).toThrow("Yarn compiler patch identity requires tracked patch bytes");
});

test("ordinary Yarn patch protocols stay outside compiler inventory", () => {
  const descriptor = "ordinary@patch:ordinary@npm%3A1.0.0#./ordinary.patch";
  const text = stringify({
    __metadata: { version: 8 },
    [descriptor]: {
      version: "1.0.0",
      resolution: descriptor,
      checksum: "a".repeat(128),
    },
  });
  expect(parseChangedLock({ file: "yarn.lock", text }).resolutions).toEqual([]);
});
