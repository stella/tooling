import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertConsumerPackedSyntax,
  packConsumerArtifacts,
} from "../packages/oxlint-config/src/consumer-compat";
import { discoverConsumerPackages } from "../packages/oxlint-config/src/consumer-compat-config";
import {
  resolveManifestContract,
  type PublishTarget,
} from "../packages/oxlint-config/src/publish-contract";
import policy from "../packages/oxlint-config/toolchain.json";

type PackedSyntaxIntegrationOptions = Pick<
  Parameters<typeof packConsumerArtifacts>[0],
  "tools"
> & { scratch: string };
export const assertConsumerPackedSyntaxIntegration = async ({
  tools,
  scratch,
}: PackedSyntaxIntegrationOptions) => {
  for (const manager of ["npm", "pnpm"] as const) {
    const root = path.join(scratch, `packed-syntax-${manager}`);
    const packing = path.join(scratch, `packed-syntax-check-${manager}`);
    await mkdir(packing);
    const version =
      manager === "npm" ? policy.consumerNpm : policy.consumerPnpm;
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        private: true,
        workspaces: ["packages/*"],
      }),
      ".github/workflows/publish.yml": `name: Publish\non: workflow_dispatch\njobs:\n  pack:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm install --global --ignore-scripts ${manager}@${version}\n      - run: ${manager} pack ${manager === "npm" ? "--ignore-scripts" : "--config.ignore-scripts=true"} --pack-destination artifacts\n`,
    };
    if (manager === "pnpm")
      files["pnpm-workspace.yaml"] = "packages:\n  - packages/*\n";
    const cases = [
      {
        name: "supported",
        target: { type: "javascript", targets: ["es2022"] },
        chunk: "export class Supported { static field = 1; }\n",
        error: undefined,
      },
      {
        name: "hidden-chunk",
        target: { type: "javascript", targets: ["es2019"] },
        chunk: "export const value = globalThis.optional?.value;\n",
        error: /declared syntax target/,
      },
      {
        name: "types-only",
        target: { type: "types-only" },
        chunk: "export const unexpected = true;\n",
        error: /Types-only artifact contains JavaScript/,
      },
      {
        name: "unbounded",
        target: { type: "javascript", targets: ["esnext"] },
        chunk: "export const syntax = ;\n",
        error: /declared syntax target|consumer Node/,
      },
    ] satisfies {
      name: string;
      target: PublishTarget;
      chunk: string;
      error: RegExp | undefined;
    }[];
    for (const entry of cases) {
      const manifest = {
        name: `packed-syntax-${entry.name}`,
        version: "1.0.0",
        type: "module",
        files: ["dist"],
        exports: "./dist/index.js",
      };
      const directory = `packages/${entry.name}`;
      files[`${directory}/package.json`] = JSON.stringify(manifest);
      files[`${directory}/publish-contract.json`] = JSON.stringify(
        resolveManifestContract({
          packer: manager,
          manifest,
          target: entry.target,
        }),
      );
      files[`${directory}/dist/index.js`] = "export const entry = true;\n";
      files[`${directory}/dist/chunks/hidden.mjs`] = entry.chunk;
    }
    files["packages/hidden-chunk/package.json"] = JSON.stringify({
      name: "packed-syntax-hidden-chunk",
      version: "1.0.0",
      type: "module",
      files: ["dist", "bin"],
      exports: "./dist/index.js",
      bin: { tool: "./bin/tool" },
    });
    files["packages/hidden-chunk/publish-contract.json"] = JSON.stringify(
      resolveManifestContract({
        packer: manager,
        manifest: JSON.parse(files["packages/hidden-chunk/package.json"]),
        target: { type: "javascript", targets: ["es2019"] },
      }),
    );
    files["packages/hidden-chunk/dist/chunks/hidden.mjs"] =
      "export const valid = true;\n";
    files["packages/hidden-chunk/bin/tool"] =
      "#!/usr/bin/env node\nconst newer = globalThis.optional?.value;\n";
    for (const [file, contents] of Object.entries(files)) {
      const destination = path.join(root, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, contents);
    }
    const packages = discoverConsumerPackages(files);
    const artifacts = await packConsumerArtifacts({
      files,
      root,
      scratch: packing,
      tools,
      packages,
      workspacePackages: packages,
    });
    const inspect = (name: string, tracked = files) => {
      const archive = artifacts.get(name);
      assert.ok(archive);
      return assertConsumerPackedSyntax({
        artifacts: new Map([[name, archive]]),
        packages,
        files: tracked,
        node: policy.consumerNode,
        typescript: policy.consumerTypescript,
        executable: tools.node,
      });
    };
    for (const entry of cases) {
      const name = `packed-syntax-${entry.name}`;
      if (entry.error) await assert.rejects(inspect(name), entry.error);
      else await inspect(name);
    }
    const changed = { ...files };
    const manifest = {
      name: "packed-syntax-supported",
      version: "1.0.0",
      type: "module",
      exports: "./different.js",
    };
    changed["packages/supported/publish-contract.json"] = JSON.stringify(
      resolveManifestContract({
        packer: manager,
        manifest,
        target: { type: "javascript", targets: ["es2022"] },
      }),
    );
    await assert.rejects(
      inspect("packed-syntax-supported", changed),
      /Packed publish contract differs/,
    );
    process.stdout.write(
      `${manager}: actual tarball syntax, hidden chunks, types-only, unbounded targets and manifest equality checked on consumer Node\n`,
    );
  }
};
