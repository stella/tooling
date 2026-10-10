import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { packConsumerArtifacts } from "../packages/oxlint-config/src/consumer-compat";
import { discoverConsumerPackages } from "../packages/oxlint-config/src/consumer-compat-config";

type ReleasePackParityOptions = Pick<
  Parameters<typeof packConsumerArtifacts>[0],
  "tools"
> & { scratch: string };
export const assertConsumerReleasePackParity = async ({
  tools,
  scratch,
}: ReleasePackParityOptions) => {
  const root = path.join(scratch, "release-pack-fixture");
  const packing = path.join(scratch, "release-pack-check");
  await mkdir(packing);
  const files = {
    "package.json": JSON.stringify({
      private: true,
      workspaces: {
        packages: ["packages/*"],
        catalog: { "is-number": "7.0.0" },
      },
    }),
    "packages/core/package.json": JSON.stringify({
      name: "consumer-pack-core",
      version: "1.0.0",
      files: ["index.js"],
    }),
    "packages/library/package.json": JSON.stringify({
      name: "consumer-pack-library",
      version: "1.0.0",
      files: ["index.js"],
      dependencies: {
        "consumer-pack-core": "workspace:*",
        "is-number": "catalog:",
      },
    }),
    ".github/workflows/publish.yml": await readFile(
      path.join(import.meta.dir, "../.github/workflows/publish.yml"),
      "utf8",
    ),
  };
  for (const [file, contents] of Object.entries(files)) {
    const destination = path.join(root, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  for (const directory of ["core", "library"])
    await writeFile(
      path.join(root, "packages", directory, "index.js"),
      "module.exports = {};\n",
    );
  const packages = discoverConsumerPackages(files);
  const artifacts = await packConsumerArtifacts({
    files,
    root,
    scratch: packing,
    tools,
    packages,
    workspacePackages: packages,
  });
  const artifact = artifacts.get("consumer-pack-library");
  assert.ok(artifact);
  const source: unknown = JSON.parse(
    execFileSync("tar", ["-xOf", artifact, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  assert.ok(
    typeof source === "object" && source !== null && "dependencies" in source,
  );
  const dependencies = source.dependencies;
  assert.ok(
    typeof dependencies === "object" &&
      dependencies !== null &&
      "consumer-pack-core" in dependencies,
  );
  assert.equal(
    dependencies["consumer-pack-core"],
    "workspace:*",
    "consumer packing must preserve what the release npm pack emits, without a pnpm rewrite",
  );
  assert.ok("is-number" in dependencies);
  assert.equal(dependencies["is-number"], "catalog:");
  process.stdout.write(
    "release packer parity: actual npm tarball preserves source workspace specifiers\n",
  );
};
