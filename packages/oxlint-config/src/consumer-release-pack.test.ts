import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  consumerReleasePackArguments,
  resolveConsumerReleasePack,
} from "./consumer-release-pack";

const workflow = ".github/workflows/publish.yml";
const source = readFileSync(
  new URL("../../../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);
const fixture = (setup: string, command: string) => ({
  [workflow]: `jobs:\n  pack:\n    steps:\n      - run: '${setup}'\n      - run: '${command}'\n`,
});

test("tracked release packer preserves npm flags without implicit pnpm projection", () => {
  const packer = resolveConsumerReleasePack({ [workflow]: source });
  expect(packer.manager).toBe("npm");
  expect(packer.version).toBe("11.11.1");
  expect(
    consumerReleasePackArguments({ packer, directory: "/tmp/artifacts" }),
  ).toEqual([
    "pack",
    "--ignore-scripts",
    "--pack-destination",
    "/tmp/artifacts",
  ]);
});

test("pnpm release setup supplies its exact packer and static semantic flags", () => {
  const files = {
    [workflow]: `jobs:\n  pack:\n    steps:\n      - uses: pnpm/action-setup@${"a".repeat(40)}\n        with: {version: 12.9.1}\n      - run: pnpm pack --ignore-scripts --pack-destination release-artifacts\n`,
  };
  const packer = resolveConsumerReleasePack(files);
  expect(packer.manager).toBe("pnpm");
  expect(packer.version).toBe("12.9.1");
  expect(
    consumerReleasePackArguments({ packer, directory: "/tmp/pnpm" }),
  ).toEqual(["pack", "--ignore-scripts", "--pack-destination", "/tmp/pnpm"]);
});

test("release packing requires one exact setup and one supported pack command", () => {
  for (const files of [
    {},
    fixture("npm install --global npm@11.11.1", "npm pack --ignore-scripts"),
    fixture(
      "npm install --global npm@11.11.1",
      "npm pack --pack-destination release-artifacts",
    ),
    fixture("npm install --global npm@latest", "npm pack --ignore-scripts"),
    fixture("npm install --global npm@11.11.1", "pnpm pack --ignore-scripts"),
    fixture("npm install --global npm@11.11.1", "npm pack --dry-run"),
    fixture("npm install --global npm@11.11.1", "npm pack && npm publish"),
    fixture(
      "npm install --global npm@11.11.1",
      "npm pack --pack-destination $OUTPUT",
    ),
    { [workflow]: source, ".github/workflows/second.yml": source },
    {
      [workflow]: source.replace(
        "npm pack --ignore-scripts",
        "npm pack --ignore-scripts\n            npm pack --ignore-scripts",
      ),
    },
    { [workflow]: source.replace("npm@11.11.1", "pnpm@12.9.1") },
  ])
    expect(() => resolveConsumerReleasePack(files)).toThrow();
});

test("pnpm config script suppression preserves the release flags without allowing scripts", () => {
  const packer = resolveConsumerReleasePack(
    fixture(
      "npm install --global --ignore-scripts pnpm@10.0.0",
      "pnpm pack --config.ignore-scripts=true --pack-destination artifacts",
    ),
  );
  expect(
    consumerReleasePackArguments({ packer, directory: "/tmp/artifacts" }),
  ).toEqual([
    "pack",
    "--config.ignore-scripts=true",
    "--pack-destination",
    "/tmp/artifacts",
  ]);
  for (const command of [
    "pnpm pack --pack-destination artifacts",
    "pnpm pack --config.ignore-scripts=false --pack-destination artifacts",
    "pnpm pack --config.ignore-scripts=latest --pack-destination artifacts",
  ])
    expect(() =>
      resolveConsumerReleasePack(
        fixture("npm install --global pnpm@10.0.0", command),
      ),
    ).toThrow();
  expect(() =>
    resolveConsumerReleasePack(
      fixture(
        "npm install --global npm@11.11.1",
        "npm pack --config.ignore-scripts=true --pack-destination artifacts",
      ),
    ),
  ).toThrow();
});

test("unrelated pnpm setup jobs do not constrain the release packer", () => {
  const unrelated = `.github/workflows/unrelated.yml`;
  for (const setup of [
    "      - uses: pnpm/action-setup@v4\n        with: {version: latest}\n",
    "      - uses: pnpm/action-setup@v4\n        if: false\n",
    "      - run: npm install --global pnpm@latest\n",
  ]) {
    const npm = resolveConsumerReleasePack({
      [workflow]: source,
      [unrelated]: `jobs:\n  other:\n    steps:\n${setup}      - run: pnpm test\n`,
    });
    expect(npm.manager).toBe("npm");
    expect(npm.version).toBe("11.11.1");
    expect(() =>
      resolveConsumerReleasePack({
        [workflow]: `jobs:\n  pack:\n    steps:\n${setup}      - run: pnpm pack --ignore-scripts --pack-destination artifacts\n`,
      }),
    ).toThrow();
  }
});

const shellWorkflow = (commands: readonly string[]) => ({
  [workflow]: JSON.stringify({
    jobs: {
      pack: {
        "runs-on": "ubuntu-latest",
        steps: commands.map((run) => ({ shell: "bash", run })),
      },
    },
  }),
});

test("release setup must be a literal top-level command in separate and shared pack steps", () => {
  for (const manager of ["npm", "pnpm"] as const) {
    const version = manager === "npm" ? "11.11.1" : "12.9.1";
    const setup = `npm install --global --ignore-scripts ${manager}@${version}`;
    const pack = `${manager} pack --ignore-scripts --pack-destination artifacts`;
    for (const commands of [
      [setup, pack],
      [`set -euo pipefail\n${setup}\n${pack}`],
    ]) {
      const selected = resolveConsumerReleasePack(shellWorkflow(commands));
      expect(selected.manager).toBe(manager);
      expect(selected.version).toBe(version);
    }
    for (const conditional of [
      `if false; then\n${setup}\nfi`,
      `false && ${setup}`,
      `true || ${setup}`,
      `for package in npm; do\n${setup}\ndone`,
      `while false; do\n${setup}\ndone`,
      `until true; do\n${setup}\ndone`,
      `case "$MODE" in\nrelease)\n${setup}\n;;\nesac`,
      `(\n${setup}\n)`,
      `setup_packer() {\n${setup}\n}\nsetup_packer`,
      `function setup_packer {\n${setup}\n}`,
      `{\n${setup}\n} &\nwait`,
      `${setup} &\nwait`,
    ])
      for (const commands of [[conditional, pack], [`${conditional}\n${pack}`]])
        expect(() =>
          resolveConsumerReleasePack(shellWorkflow(commands)),
        ).toThrow();
  }
});

test("top-level setup permits the release workflow's unconditional directory pack subshell", () => {
  const selected = resolveConsumerReleasePack(
    shellWorkflow([
      "npm install --global --ignore-scripts npm@11.11.1",
      'set -euo pipefail\n(\n  cd "packages/library"\n  npm pack --ignore-scripts --pack-destination "$GITHUB_WORKSPACE/release-artifacts"\n)',
    ]),
  );
  expect(selected.manager).toBe("npm");
  expect(selected.version).toBe("11.11.1");
  expect(
    consumerReleasePackArguments({
      packer: selected,
      directory: "/tmp/artifacts",
    }),
  ).toEqual([
    "pack",
    "--ignore-scripts",
    "--pack-destination",
    "/tmp/artifacts",
  ]);
});

test("quoted command text and terminated setup steps cannot establish a release packer", () => {
  const setup = "npm install --global --ignore-scripts npm@11.11.1";
  const pack = "npm pack --ignore-scripts --pack-destination artifacts";
  for (const commands of [
    [`printf '%s\\n' '\n${setup}\n'`, pack],
    [`exit 0\n${setup}`, pack],
    [`exec true\n${setup}`, pack],
    [setup, `printf '%s\\n' '\n${pack}\n'`],
    [`printf '%s\\n' '\n${setup}\n'\n${pack}`],
    [`exit 0\n${setup}\n${pack}`],
    [`exec true\n${setup}\n${pack}`],
  ])
    expect(() => resolveConsumerReleasePack(shellWorkflow(commands))).toThrow();
});

test("inherited non-shell release setup and pack steps fail closed", () => {
  const commands = [
    { run: "npm install --global --ignore-scripts npm@11.11.1" },
    { run: "npm pack --ignore-scripts --pack-destination artifacts" },
  ];
  for (const workflowSource of [
    {
      defaults: { run: { shell: "python" } },
      jobs: { pack: { steps: commands } },
    },
    {
      jobs: {
        pack: { defaults: { run: { shell: "python" } }, steps: commands },
      },
    },
  ])
    expect(() =>
      resolveConsumerReleasePack({
        [workflow]: JSON.stringify(workflowSource),
      }),
    ).toThrow();
});

test("shell command hashing cannot replace the declared release packer", () => {
  expect(() =>
    resolveConsumerReleasePack(
      shellWorkflow([
        "npm install --global --ignore-scripts npm@11.11.1",
        "hash -p /bin/true npm\nnpm pack --ignore-scripts --pack-destination artifacts",
      ]),
    ),
  ).toThrow();
});
