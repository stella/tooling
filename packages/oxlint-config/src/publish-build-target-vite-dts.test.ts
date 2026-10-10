import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertDeclarationOnlyOutput,
  createDeclarationEmissionLedger,
  guardDeclarationHook,
  reviewedViteDtsOptions,
  snapshotDeclarationBundle,
  snapshotDeclarationDirectory,
} from "./publish-build-target-vite-dts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const outputDirectory = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "reviewed-vite-dts-"));
  directories.push(directory);
  return directory;
};

test("default and existing static declaration options are frozen and isolated from caller mutation", () => {
  expect(reviewedViteDtsOptions()).toEqual({});
  const include = ["src/**/*"];
  const compilerOptions = { declarationMap: false };
  const options = reviewedViteDtsOptions({
    include,
    exclude: ["src/**/*.test.ts"],
    entryRoot: "src",
    pathsToAliases: false,
    compilerOptions,
  });
  include.push("outside/**/*");
  compilerOptions.declarationMap = true;
  expect(options.include).toEqual(["src/**/*"]);
  expect(options.compilerOptions).toEqual({ declarationMap: false });
  expect(Object.isFrozen(options)).toBe(true);
  expect(Object.isFrozen(options.include)).toBe(true);
});

test("the option boundary rejects every callback and output-changing escape in the reviewed profile", () => {
  for (const key of [
    "afterBootstrap",
    "afterDiagnostic",
    "beforeWriteFile",
    "afterRollup",
    "afterBuild",
    "resolvers",
    "processor",
    "root",
    "outDirs",
    "bundleTypes",
    "aliases",
  ])
    expect(() => reviewedViteDtsOptions({ [key]: () => undefined })).toThrow(
      "Unreviewed",
    );
  for (const options of [
    { declarationOnly: true },
    { strictOutput: false },
    { compilerOptions: { declarationMap: true } },
    { compilerOptions: { declarationMap: false, plugins: [] } },
    { include: "../outside/*" },
    { entryRoot: "/outside" },
  ])
    expect(() => reviewedViteDtsOptions(options)).toThrow();
  const hidden = Object.defineProperty({}, "afterBuild", {
    value: () => undefined,
  });
  expect(() => reviewedViteDtsOptions(hidden)).toThrow("Unreviewed");
  expect(() =>
    reviewedViteDtsOptions(
      Object.defineProperty({}, "include", { get: () => ["src/*"] }),
    ),
  ).toThrow("accessors");
});

test("bundle snapshots retain original bytes despite later producer mutation", () => {
  const asset = { type: "asset", fileName: "index.js", source: "original" };
  const before = snapshotDeclarationBundle({ "index.js": asset });
  asset.source = "changed";
  expect(Object.isFrozen(before)).toBe(true);
  expect(() =>
    assertDeclarationOnlyOutput({
      before,
      after: snapshotDeclarationBundle({ "index.js": asset }),
    }),
  ).toThrow("index.js");
});

test("only declaration files and their maps can be emitted or changed", () => {
  for (const file of [
    "index.d.ts",
    "index.d.mts",
    "index.d.cts",
    "index.d.ts.map",
    "index.d.cts.map",
  ]) {
    const after = snapshotDeclarationBundle({
      [file]: { type: "asset", fileName: file, source: "declaration" },
    });
    expect(() =>
      assertDeclarationOnlyOutput({ before: {}, after }),
    ).not.toThrow();
  }
  for (const file of ["index.js", "index.mjs", "index.cjs", "index.css"]) {
    const after = snapshotDeclarationBundle({
      [file]: { type: "asset", fileName: file, source: "code" },
    });
    expect(() => assertDeclarationOnlyOutput({ before: {}, after })).toThrow(
      file,
    );
    expect(() =>
      assertDeclarationOnlyOutput({ before: after, after: {} }),
    ).toThrow(file);
  }
});

test("the actual wrapped hook preserves its receiver and arguments while guarding direct disk writes", async () => {
  const directory = outputDirectory();
  writeFileSync(path.join(directory, "index.js"), "original");
  const receiver = { marker: "original" };
  const bundle = {
    "index.js": { type: "chunk", fileName: "index.js", code: "original" },
  };
  function producer(this: unknown, ...args: unknown[]) {
    expect(this).not.toBe(receiver);
    expect(Reflect.get(Object(this), "marker")).toBe("original");
    expect(args).toEqual([{}, bundle]);
    writeFileSync(
      path.join(directory, "index.d.ts"),
      "export declare const value: number;",
    );
  }
  const guarded = guardDeclarationHook({
    hook: producer,
    hookName: "writeBundle",
    outputDirectories: [directory],
  });
  await guarded.call(receiver, {}, bundle);
  expect(Object.keys(snapshotDeclarationDirectory(directory)).sort()).toEqual([
    "index.d.ts",
    "index.js",
  ]);
  for (const file of ["index.js", "index.mjs", "index.cjs"]) {
    const mutate = guardDeclarationHook({
      hook: () => {
        writeFileSync(path.join(directory, file), "changed");
      },
      hookName: "writeBundle",
      outputDirectories: [directory],
    });
    const failure = await mutate
      .call(receiver, {}, bundle)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) expect(failure.message).toContain(file);
  }
});

test("the emission ledger rejects deferred JavaScript and foreign asset updates", () => {
  const ledger = createDeclarationEmissionLedger();
  const assets = new Map<string, string>();
  const host = {
    emitFile: (asset: unknown) => {
      if (
        typeof asset !== "object" ||
        asset === null ||
        !("fileName" in asset) ||
        typeof asset.fileName !== "string"
      )
        throw new Error("Invalid fixture asset");
      const reference = `asset-${assets.size}`;
      assets.set(reference, asset.fileName);
      return reference;
    },
    getFileName: (reference: unknown) =>
      typeof reference === "string" ? assets.get(reference) : undefined,
    setAssetSource: () => undefined,
    emitChunk: () => {
      throw new Error("Unknown API reached host");
    },
  };
  const context = ledger.wrapContext(host);
  const emit = context["emitFile"];
  if (typeof emit !== "function") throw new Error("Missing fixture emitFile");
  expect(() =>
    emit({ type: "asset", fileName: "index.js", source: "deferred" }),
  ).toThrow("Declaration plugin");
  const reference: unknown = emit({
    type: "asset",
    fileName: "index.d.cts",
    source: "declaration",
  });
  expect(reference).toBe("asset-0");
  expect(() => ledger.audit()).not.toThrow();
  const update = context["setAssetSource"];
  if (typeof update !== "function")
    throw new Error("Missing fixture setAssetSource");
  expect(() => update(reference, "updated declaration")).not.toThrow();
  expect(() => update("foreign", "modified JS")).toThrow("foreign");
  expect(() => Reflect.get(context, "emitChunk")).toThrow("Declaration plugin");
  assets.set("asset-0", "index.js");
  expect(() => ledger.audit()).toThrow("Declaration plugin");
});

test("a shared emitter ledger audits deferred references in output hooks", async () => {
  const ledger = createDeclarationEmissionLedger();
  let resolved = "index.d.ts";
  const host = {
    emitFile: () => "deferred-asset",
    getFileName: () => resolved,
  };
  const context = ledger.wrapContext(host);
  const emit = context["emitFile"];
  if (typeof emit !== "function") throw new Error("Missing fixture emitFile");
  emit({ type: "asset", fileName: "index.d.ts" });
  const guarded = guardDeclarationHook({
    hook: () => undefined,
    hookName: "generateBundle",
    outputDirectories: [],
    ledger,
  });
  await guarded.call(host, {}, {});
  resolved = "index.mjs";
  const failed = await guarded
    .call(host, {}, {})
    .catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(Error);
  if (failed instanceof Error)
    expect(failed.message).toContain("Declaration plugin");
});

test("wrapped bundle mutations and dynamic hook return values fail", async () => {
  const bundle = {
    "index.js": { type: "chunk", fileName: "index.js", code: "original" },
  };
  const mutate = guardDeclarationHook({
    hook: () => {
      bundle["index.js"].code = "changed";
    },
    hookName: "generateBundle",
    outputDirectories: [],
  });
  const mutated = await mutate({}, bundle).catch((error: unknown) => error);
  expect(mutated).toBeInstanceOf(Error);
  if (mutated instanceof Error) expect(mutated.message).toContain("index.js");
  const dynamic = guardDeclarationHook({
    hook: () => ({ code: "replacement" }),
    hookName: "transform",
    outputDirectories: [],
  });
  const returned = await dynamic("original", "src/index.ts").catch(
    (error: unknown) => error,
  );
  expect(returned).toBeInstanceOf(Error);
  if (returned instanceof Error)
    expect(returned.message).toContain("dynamic build change");
});

test("bundle snapshots read emitted bytes and ignore output metadata getters", () => {
  const chunk = {
    type: "chunk",
    fileName: "index.js",
    code: "original",
    get modules() {
      throw new Error("output metadata getter must not run");
    },
  };
  const map = { type: "asset", fileName: "index.js.map", source: "AAAA" };
  const bundle = { "index.js": chunk, "index.js.map": map };
  const before = snapshotDeclarationBundle(bundle);
  expect(() =>
    assertDeclarationOnlyOutput({
      before,
      after: snapshotDeclarationBundle(bundle),
    }),
  ).not.toThrow();
  map.source = "BBBB";
  expect(() =>
    assertDeclarationOnlyOutput({
      before,
      after: snapshotDeclarationBundle(bundle),
    }),
  ).toThrow("index.js.map");
});
