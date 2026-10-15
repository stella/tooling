/// <reference types="bun-types" />
import { expect, test } from "bun:test";

import { renderCloudShellProfile } from "./cloud-setup-shell";

const nodeVersion = "26.10.0";
const bunVersion = "1.4.3";
const managed = [
  `/opt/stll-cloud/node/${nodeVersion}/bin`,
  `/opt/stll-cloud/bun/${bunVersion}`,
  "/usr/local/bin",
];
const profile = renderCloudShellProfile({
  nodeVersion,
  bunVersion,
  rust: undefined,
});

test("managed PATH prepending is an idempotent projection that preserves every unrelated entry", () => {
  const entries = [
    "",
    "/usr/bin",
    "/opt/old-bun",
    "/opt/old-node",
    "/tmp/space dir",
    "/tmp/$literal",
    "/tmp/'quote",
    ...managed,
  ];
  let seed = 12345;
  for (let sample = 0; sample < 100; sample++) {
    const path = [];
    for (let index = 0; index < 1 + (sample % 9); index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const entry = entries.at(seed % entries.length);
      if (entry === undefined) throw new Error("PATH fixture index absent");
      path.push(entry);
    }
    const expected = [
      ...managed,
      ...path.filter((entry) => !managed.includes(entry)),
    ].join(":");
    const result = Bun.spawnSync(
      [
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        `${profile}\nfirst="$PATH"\n${profile}\n[[ "$first" == "$PATH" ]] || exit 1\nprintf '%s' "$PATH"`,
      ],
      { env: { ...process.env, PATH: path.join(":") } },
    );
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(expected);
  }
});
