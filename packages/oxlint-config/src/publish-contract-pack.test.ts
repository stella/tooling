import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  publishConfigOverrideKeys,
  resolveManifestContract,
} from "./publish-contract";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pnpmExecutable = () => {
  const packageFile = createRequire(import.meta.url).resolve(
    "pnpm/package.json",
  );
  const installed: unknown = JSON.parse(readFileSync(packageFile, "utf8"));
  if (
    !object(installed) ||
    installed["version"] !== "12.9.1" ||
    !object(installed["bin"]) ||
    typeof installed["bin"]["pnpm"] !== "string"
  )
    throw new Error("pack contract fixture requires pnpm 12.9.1");
  return path.resolve(path.dirname(packageFile), installed["bin"]["pnpm"]);
};

test("pnpm pack preserves the modeled published contract projection", () => {
  const root = mkdtempSync(path.join(tmpdir(), "publish-contract-pack-"));
  try {
    mkdirSync(path.join(root, "dist"));
    mkdirSync(path.join(root, "packed"));
    for (const file of [
      "index.js",
      "index.cjs",
      "index.d.ts",
      "legacy.d.ts",
      "cli.js",
    ])
      writeFileSync(path.join(root, "dist", file), "export {};\n");
    const manifest = {
      name: "publication-contract-fixture",
      version: "1.0.0",
      type: "module",
      files: ["dist"],
      engines: { node: ">=22" },
      peerDependencies: { typescript: ">=6 <8" },
      exports: { ".": "./source/index.js" },
      main: "./source/index.cjs",
      module: "./source/index.js",
      types: "./source/index.d.ts",
      typings: "./source/legacy.d.ts",
      bin: { fixture: "./source/cli.js" },
      typesVersions: { "*": { "*": ["source/*"] } },
      publishConfig: {
        access: "public",
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            import: "./dist/index.js",
            require: "./dist/index.cjs",
          },
        },
        main: "./dist/index.cjs",
        module: "./dist/index.js",
        types: "./dist/index.d.ts",
        typings: "./dist/legacy.d.ts",
        bin: { fixture: "./dist/cli.js" },
        typesVersions: { "*": { "*": ["dist/*"] } },
      },
    };
    expect(
      Object.keys(manifest.publishConfig)
        .filter((key) => key !== "access")
        .sort(),
    ).toEqual([...publishConfigOverrideKeys].sort());
    writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    execFileSync(
      pnpmExecutable(),
      [
        "--config.ignore-scripts=true",
        "--config.manage-package-manager-versions=false",
        "pack",
        "--pack-destination",
        path.join(root, "packed"),
      ],
      { cwd: root, stdio: "pipe", timeout: 30_000 },
    );
    const archives = readdirSync(path.join(root, "packed"));
    expect(archives).toHaveLength(1);
    const archive = archives.at(0);
    if (archive === undefined)
      throw new Error("pack did not produce an archive");
    const packed: unknown = JSON.parse(
      execFileSync(
        "tar",
        ["-xOf", path.join(root, "packed", archive), "package/package.json"],
        { encoding: "utf8" },
      ),
    );
    const target = { type: "javascript", targets: ["es2022"] } as const;
    expect(resolveManifestContract({ manifest: packed, target })).toEqual(
      resolveManifestContract({ manifest, target }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
