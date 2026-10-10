import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { satisfies } from "semver";
import { stringify } from "yaml";

import {
  consumerPackageClosure,
  consumerStagingPaths,
  consumerPackRootManifest,
  assertConsumerFixtureManifest,
  assertConsumerFixtureKind,
  assertConsumerFixtureSelection,
  bindConsumerManifest,
  consumerDependencyConfigFiles,
  consumerRecord,
  consumerRelativePath,
  discoverConsumerPackages,
  oldestPublishedConsumerVersion,
  parseConsumerFixtures,
  type ConsumerFixture,
  type ConsumerPackage,
} from "./consumer-compat-config";
import { parseToolchainPolicy } from "./toolchain-schema";

type CommandOptions = { cwd: string; env?: NodeJS.ProcessEnv };
const execute = (
  executable: string,
  args: readonly string[],
  { cwd, env = process.env }: CommandOptions,
) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const output = Buffer.concat(chunks).toString("utf8");
      if (code !== 0)
        reject(
          new Error(
            `${executable} failed (${signal ?? String(code)}): ${output.trim()}`,
          ),
        );
      else resolve(output);
    });
  });

const jsonFile = async (file: string) => {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!consumerRecord(value)) throw new Error(`expected JSON object: ${file}`);
  return value;
};

const containedDirectory = async (root: string, relative: string) => {
  const location = await realpath(path.resolve(root, relative));
  const difference = path.relative(root, location);
  if (
    difference.startsWith(`..${path.sep}`) ||
    difference === ".." ||
    path.isAbsolute(difference)
  )
    throw new Error(`path leaves repository: ${relative}`);
  if (!(await lstat(location)).isDirectory())
    throw new Error(`not a directory: ${relative}`);
  return location;
};

const fetchBytes = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`download failed (${response.status}): ${url}`);
  if (new URL(response.url).hostname !== new URL(url).hostname)
    throw new Error(`download redirected to another host: ${url}`);
  return Buffer.from(await response.arrayBuffer());
};

export const verifyConsumerNodeArchive = ({
  filename,
  checksums,
  archive,
}: {
  filename: string;
  checksums: string;
  archive: Uint8Array;
}) => {
  const hashes = checksums.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-f0-9]{64})\s+\*?(\S+)$/.exec(line);
    return match?.[2] === filename && match[1] ? [match[1]] : [];
  });
  if (
    hashes.length !== 1 ||
    hashes[0] !== createHash("sha256").update(archive).digest("hex")
  )
    throw new Error(`Node archive checksum mismatch: ${filename}`);
};

type ConsumerTools = { node: string; npm: string; pnpm: string; bin: string };
type WriteConsumerToolWrappersOptions = {
  node: string;
  npm: string;
  pnpm: string;
  directory: string;
};
export const writeConsumerToolWrappers = async ({
  node,
  npm,
  pnpm,
  directory,
}: WriteConsumerToolWrappersOptions) => {
  // Explicit wrappers keep fixture scripts and nested package-manager invocations on the consumer runtime.
  const wrappers = directory;
  await mkdir(wrappers);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const [name, cli] of [
    ["npm", npm],
    ["pnpm", pnpm],
  ]) {
    if (!name || !cli) throw new Error("missing package manager binding");
    await writeFile(
      path.join(wrappers, name),
      `#!/bin/sh\nexec ${quote(node)} ${quote(cli)} "$@"\n`,
      { mode: 0o755 },
    );
  }
  return {
    node,
    npm,
    pnpm,
    bin: `${wrappers}${path.delimiter}${path.dirname(node)}`,
  };
};

const provisionConsumerTools = async (
  scratch: string,
  policy: ReturnType<typeof parseToolchainPolicy>,
): Promise<ConsumerTools> => {
  if (
    process.platform !== "linux" ||
    (process.arch !== "x64" && process.arch !== "arm64")
  )
    throw new Error("consumer compatibility requires Linux x64 or arm64");
  const filename = `node-v${policy.consumerNode}-linux-${process.arch}.tar.xz`;
  const base = `https://nodejs.org/dist/v${policy.consumerNode}/`;
  const [archive, checksums] = await Promise.all([
    fetchBytes(`${base}${filename}`),
    fetchBytes(`${base}SHASUMS256.txt`),
  ]);
  verifyConsumerNodeArchive({
    filename,
    archive,
    checksums: checksums.toString("utf8"),
  });
  const archivePath = path.join(scratch, filename);
  await writeFile(archivePath, archive);
  await execute(
    "tar",
    ["-xJf", archivePath, "-C", scratch, "--no-same-owner"],
    { cwd: scratch },
  );
  const installation = path.join(scratch, filename.slice(0, -7));
  const bin = path.join(installation, "bin");
  const node = path.join(bin, "node");
  const home = path.join(scratch, "tools-home");
  await mkdir(home);
  await writeFile(path.join(home, "npmrc"), "");
  const env = consumerCommandEnvironment({
    tools: { bin },
    directory: scratch,
    home,
  });
  const actual = (
    await execute(node, ["--version"], { cwd: scratch, env })
  ).trim();
  if (actual !== `v${policy.consumerNode}`)
    throw new Error(`consumer Node version mismatch: ${actual}`);
  const prefix = path.join(scratch, "tools");
  const npmBootstrap = path.join(
    installation,
    "lib/node_modules/npm/bin/npm-cli.js",
  );
  await execute(
    node,
    [
      npmBootstrap,
      "install",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      `npm@${policy.consumerNpm}`,
      `pnpm@${policy.consumerPnpm}`,
    ],
    { cwd: scratch, env },
  );
  const npm = path.join(prefix, "node_modules/npm/bin/npm-cli.js");
  // pnpm 12 retains its Node launcher when lifecycle scripts are disabled.
  const pnpm = path.join(prefix, "node_modules/pnpm/pnpm");
  for (const [cli, expected] of [
    [npm, policy.consumerNpm],
    [pnpm, policy.consumerPnpm],
  ]) {
    if (
      !cli ||
      !expected ||
      (
        await execute(node, [cli, "--version"], { cwd: scratch, env })
      ).trim() !== expected
    )
      throw new Error("consumer package manager version mismatch");
  }
  return writeConsumerToolWrappers({
    node,
    npm,
    pnpm,
    directory: path.join(scratch, "consumer-bin"),
  });
};

const trackedManifests = async (root: string) => {
  const listed = await execute(
    "git",
    [
      "ls-files",
      "-z",
      "--",
      "package.json",
      "**/package.json",
      "pnpm-workspace.yaml",
      "**/pnpm-workspace.yaml",
    ],
    { cwd: root },
  );
  const files: Record<string, string> = {};
  for (const file of listed.split("\0").filter(Boolean)) {
    if (
      file
        .split("/")
        .some((part) => part === "node_modules" || part === "vendor")
    )
      continue;
    const location = await realpath(path.join(root, file));
    const relative = path.relative(root, location);
    if (
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    )
      throw new Error(`tracked manifest leaves repository: ${file}`);
    files[file] = await readFile(location, "utf8");
  }
  return files;
};

const packFilename = async (directory: string) => {
  const files = (await readdir(directory)).filter((file) =>
    file.endsWith(".tgz"),
  );
  if (files.length !== 1)
    throw new Error(`expected exactly one package tarball: ${directory}`);
  const filename = files.at(0);
  if (!filename) throw new Error("missing package tarball");
  return path.join(directory, filename);
};

const copyWithoutDependencies = async (source: string, destination: string) => {
  await cp(source, destination, {
    recursive: true,
    filter: async (file) => {
      if (["node_modules", ".git"].includes(path.basename(file))) return false;
      if ((await lstat(file)).isSymbolicLink())
        throw new Error(`consumer staging does not accept symlinks: ${file}`);
      return true;
    },
  });
};

type StageConsumerWorkspaceOptions = {
  root: string;
  staging: string;
  packages: Map<string, ConsumerPackage>;
};
export const stageConsumerWorkspace = async ({
  root,
  staging,
  packages,
}: StageConsumerWorkspaceOptions) => {
  const directories = new Map<string, string>();
  const paths = consumerStagingPaths(packages);
  const ordered = [...packages.values()].sort(
    (left, right) => left.directory.length - right.directory.length,
  );
  for (const pkg of ordered) {
    const relative = paths.get(pkg.name);
    if (!relative) throw new Error(`missing staging path: ${pkg.name}`);
    const destination = path.join(staging, relative);
    if (pkg.directory !== "." || pkg.manifest["private"] !== true)
      await copyWithoutDependencies(
        await containedDirectory(root, pkg.directory),
        destination,
      );
    directories.set(pkg.name, destination);
  }
  await writeFile(
    path.join(staging, "package.json"),
    JSON.stringify(consumerPackRootManifest(packages)),
  );
  return directories;
};

export const assertConsumerInstalledToolBins = async (directory: string) => {
  for (const name of ["node", "npm", "pnpm"]) {
    const file = path.join(directory, "node_modules/.bin", name);
    try {
      await lstat(file);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
    throw new Error(
      `installed consumer binary ${name} conflicts with the pinned tool before lifecycle scripts`,
    );
  }
};

export const assertConsumerFixtureFiles = async (directory: string) => {
  const visit = async (location: string) => {
    for (const entry of await readdir(location, { withFileTypes: true })) {
      if (consumerDependencyConfigFiles.some((name) => name === entry.name))
        throw new Error(
          `consumer fixture must not supply dependency-manager configuration: ${entry.name}`,
        );
      if (
        entry.isDirectory() &&
        entry.name !== "node_modules" &&
        entry.name !== ".git"
      )
        await visit(path.join(location, entry.name));
    }
  };
  await visit(directory);
  assertConsumerFixtureManifest(
    await jsonFile(path.join(directory, "package.json")),
  );
};

type PackOptions = {
  root: string;
  scratch: string;
  tools: ConsumerTools;
  packages: Map<string, ConsumerPackage>;
  workspacePackages: Map<string, ConsumerPackage>;
};
const packConsumerArtifacts = async ({
  root,
  scratch,
  tools,
  packages,
  workspacePackages,
}: PackOptions) => {
  const artifacts = new Map<string, string>();
  const staging = path.join(scratch, "pack-workspace");
  await mkdir(staging);
  const stagedDirectories = await stageConsumerWorkspace({
    root,
    staging,
    packages: workspacePackages,
  });
  const packHome = path.join(scratch, "pack-home");
  await mkdir(packHome);
  await writeFile(path.join(packHome, "npmrc"), "");
  await writeFile(
    path.join(staging, "pnpm-workspace.yaml"),
    `packages:\n${[...stagedDirectories.values()].map((directory) => `  - ${JSON.stringify(path.relative(staging, directory).split(path.sep).join("/"))}`).join("\n")}\n`,
  );
  for (const [index, pkg] of [...packages.values()].entries()) {
    const packed = path.join(scratch, `packed-${index}`);
    const final = path.join(scratch, `artifact-${index}`);
    await mkdir(packed);
    await mkdir(final);
    const directory = stagedDirectories.get(pkg.name);
    if (!directory)
      throw new Error(`missing pack workspace member: ${pkg.name}`);
    await execute(
      tools.node,
      [
        tools.pnpm,
        "--config.ignore-scripts=true",
        "--config.package-manager-strict=false",
        "--config.manage-package-manager-versions=false",
        "pack",
        "--pack-destination",
        packed,
      ],
      {
        cwd: directory,
        env: consumerCommandEnvironment({ tools, directory, home: packHome }),
      },
    );
    const archive = await packFilename(packed);
    const extracted = path.join(packed, "published");
    await mkdir(extracted);
    await execute(
      "tar",
      ["-xzf", archive, "-C", extracted, "--no-same-owner"],
      { cwd: packed },
    );
    await execute(
      tools.node,
      [tools.npm, "pack", "--ignore-scripts", "--pack-destination", final],
      {
        cwd: path.join(extracted, "package"),
        env: consumerCommandEnvironment({
          tools,
          directory: path.join(extracted, "package"),
          home: packHome,
        }),
      },
    );
    const artifact = await packFilename(final);
    artifacts.set(pkg.name, artifact);
  }
  return artifacts;
};

const registryMetadata = async (name: string) => {
  const value: unknown = JSON.parse(
    (
      await fetchBytes(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
    ).toString("utf8"),
  );
  if (!consumerRecord(value) || !consumerRecord(value["versions"]))
    throw new Error(`invalid registry response: ${name}`);
  return value["versions"];
};

export const consumerCommandEnvironment = ({
  tools,
  directory,
  home,
  environment = process.env,
}: {
  tools: Pick<ConsumerTools, "bin">;
  directory: string;
  home: string;
  environment?: NodeJS.ProcessEnv;
}) => {
  const env = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !/^(?:npm_config_|pnpm_|yarn_)/i.test(key) &&
        key !== "NODE_PATH" &&
        key !== "NODE_OPTIONS",
    ),
  );
  Object.assign(env, {
    PATH: `${tools.bin}${path.delimiter}${path.join(directory, "node_modules/.bin")}${path.delimiter}${environment["PATH"] ?? ""}`,
    HOME: home,
    npm_config_cache: path.join(home, "npm-cache"),
    npm_config_userconfig: path.join(home, "npmrc"),
    npm_config_registry: "https://registry.npmjs.org/",
    CI: "true",
    NODE_ENV: "development",
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"),
  });
  return env;
};

const fixtureCommand = (argv: string[], tools: ConsumerTools) => {
  const executable = argv.at(0);
  if (
    argv
      .slice(1)
      .some(
        (argument) =>
          path.posix.isAbsolute(argument) ||
          /(?:^|\/)\.\.(?:\/|$)/.test(argument),
      )
  )
    throw new Error(
      "consumer fixture command arguments must stay within the fixture",
    );
  if (executable === "node") return [tools.node, ...argv.slice(1)];
  if (argv[1] === "run" && executable === "npm")
    return [tools.node, tools.npm, ...argv.slice(1)];
  if (argv[1] === "run" && executable === "pnpm")
    return [tools.node, tools.pnpm, ...argv.slice(1)];
  throw new Error(
    "consumer fixture commands must use node or a declared npm/pnpm run script",
  );
};

type ConsumerFixtureCommandOptions = {
  manager: "npm" | "pnpm";
  tools: ConsumerTools;
  directory: string;
  home: string;
  fixture: ConsumerFixture;
};
export const consumerFixtureCommands = ({
  manager,
  tools,
  directory,
  home,
  fixture,
}: ConsumerFixtureCommandOptions) => {
  const install =
    manager === "npm"
      ? [tools.node, tools.npm, "install", "--no-audit", "--no-fund"]
      : [
          tools.node,
          tools.pnpm,
          "install",
          "--no-frozen-lockfile",
          "--config.store-dir",
          path.join(home, "pnpm-store"),
        ];
  return [
    install,
    [
      tools.node,
      path.join(directory, "node_modules/typescript/bin/tsc"),
      "--noEmit",
    ],
    fixtureCommand(fixture.build, tools),
    fixtureCommand(fixture.smoke, tools),
  ];
};

type FixtureOptions = {
  fixtureRoot: string;
  fixture: ConsumerFixture;
  pkg: ConsumerPackage;
  closure: Map<string, ConsumerPackage>;
  artifacts: Map<string, string>;
  scratch: string;
  tools: ConsumerTools;
  policy: ReturnType<typeof parseToolchainPolicy>;
  manager: "npm" | "pnpm";
};
const runFixture = async ({
  fixtureRoot,
  fixture,
  pkg,
  closure,
  artifacts,
  scratch,
  tools,
  policy,
  manager,
}: FixtureOptions) => {
  const selectedArtifact = artifacts.get(pkg.name);
  if (!selectedArtifact)
    throw new Error(`missing consumer artifact: ${pkg.name}`);
  const published: unknown = JSON.parse(
    await execute("tar", ["-xOf", selectedArtifact, "package/package.json"], {
      cwd: scratch,
    }),
  );
  if (!consumerRecord(published))
    throw new Error(`invalid packed package manifest: ${pkg.name}`);
  assertConsumerFixtureKind({
    fixture,
    pkg: { directory: pkg.directory, name: pkg.name, manifest: published },
  });
  const source = await containedDirectory(fixtureRoot, fixture.fixture);
  const directory = path.join(
    scratch,
    `fixture-${manager}-${createHash("sha256").update(pkg.name).digest("hex").slice(0, 16)}`,
  );
  await assertConsumerFixtureFiles(source);
  await copyWithoutDependencies(source, directory);
  const manifest = await jsonFile(path.join(directory, "package.json"));
  const needsReactDom = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ].some((field) => {
    const entries = manifest[field];
    return consumerRecord(entries) && typeof entries["react-dom"] === "string";
  });
  const reactBindings: Record<string, string> = {};
  if (fixture.kind === "react") {
    const peers = published["peerDependencies"];
    if (!consumerRecord(peers) || typeof peers["react"] !== "string")
      throw new Error(`React fixture requires a React peer: ${pkg.name}`);
    const react = oldestPublishedConsumerVersion(
      Object.keys(await registryMetadata("react")),
      peers["react"],
    );
    reactBindings["react"] = react;
    if (typeof peers["react-dom"] === "string" || needsReactDom) {
      const dom = await registryMetadata("react-dom");
      const compatible = Object.entries(dom)
        .filter(([, value]) => {
          if (
            !consumerRecord(value) ||
            !consumerRecord(value["peerDependencies"])
          )
            return false;
          const range = value["peerDependencies"]["react"];
          return typeof range === "string" && satisfies(react, range);
        })
        .map(([version]) => version);
      reactBindings["react-dom"] = oldestPublishedConsumerVersion(
        compatible,
        typeof peers["react-dom"] === "string" ? peers["react-dom"] : "*",
      );
    }
    process.stdout.write(`${pkg.name}: ${manager} React ${react}\n`);
  }
  const closureArtifacts = new Map<string, string>();
  for (const name of closure.keys()) {
    const artifact = artifacts.get(name);
    if (!artifact) throw new Error(`missing consumer artifact: ${name}`);
    closureArtifacts.set(name, artifact);
  }
  const boundManifest = bindConsumerManifest({
    manifest,
    artifacts: closureArtifacts,
    typescript: policy.consumerTypescript,
    react: reactBindings,
    manager,
  });
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify(boundManifest.manifest, null, 2)}\n`,
  );
  if (boundManifest.manager === "pnpm")
    await writeFile(
      path.join(directory, "pnpm-workspace.yaml"),
      stringify(boundManifest.workspace),
    );
  for (const lockfile of [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
  ])
    await rm(path.join(directory, lockfile), { force: true });
  const home = path.join(directory, ".consumer-home");
  await mkdir(home);
  await writeFile(path.join(home, "npmrc"), "");
  const env = consumerCommandEnvironment({ tools, directory, home });
  for (const [index, argv] of consumerFixtureCommands({
    manager,
    tools,
    directory,
    home,
    fixture,
  }).entries()) {
    const executable = argv.at(0);
    if (!executable) throw new Error("missing consumer command");
    const output = await execute(executable, argv.slice(1), {
      cwd: directory,
      env,
    });
    process.stdout.write(output);
    if (index === 0) {
      await assertConsumerInstalledToolBins(directory);
      const installed = await jsonFile(
        path.join(directory, "node_modules/typescript/package.json"),
      );
      if (installed["version"] !== policy.consumerTypescript)
        throw new Error("installed consumer TypeScript does not match policy");
    }
  }
  process.stdout.write(
    `${pkg.name}: ${manager} consumer build/types/smoke passed\n`,
  );
};

export type ConsumerCompatOptions = {
  root: string;
  packages: string[];
  consumerNode: string;
  fixturePath: string;
  policy: unknown;
};
export const runConsumerCompat = async ({
  root: inputRoot,
  packages: selected,
  consumerNode,
  fixturePath,
  policy: inputPolicy,
}: ConsumerCompatOptions) => {
  const policy = parseToolchainPolicy(inputPolicy);
  if (consumerNode !== policy.consumerNode)
    throw new Error("consumer Node must match the published toolchain policy");
  if (selected.length === 0)
    throw new Error("consumer compatibility requires at least one package");
  const root = await realpath(inputRoot);
  const fixtureRoot = await containedDirectory(
    root,
    consumerRelativePath(fixturePath, "fixture-path"),
  );
  const fixtures = parseConsumerFixtures(
    await jsonFile(path.join(fixtureRoot, "consumer-compat.json")),
  );
  assertConsumerFixtureSelection({ selected, fixtures });
  const packages = discoverConsumerPackages(await trackedManifests(root));
  const selections: {
    pkg: ConsumerPackage;
    fixture: ConsumerFixture;
    closure: Map<string, ConsumerPackage>;
  }[] = [];
  const all = new Map<string, ConsumerPackage>();
  const seen = new Set<string>();
  for (const input of selected) {
    const directory = consumerRelativePath(input, "selected package");
    if (seen.has(directory))
      throw new Error(`duplicate selected package: ${directory}`);
    seen.add(directory);
    const pkg = [...packages.values()].find(
      (candidate) => candidate.directory === directory,
    );
    if (!pkg || pkg.manifest["private"] === true)
      throw new Error(
        `selected package is not a public root or declared workspace package: ${directory}`,
      );
    const fixture = fixtures.find(
      (candidate) => candidate.package === directory,
    );
    if (!fixture)
      throw new Error(`missing declared consumer fixture: ${directory}`);
    assertConsumerFixtureKind({ fixture, pkg });
    await assertConsumerFixtureFiles(
      await containedDirectory(fixtureRoot, fixture.fixture),
    );
    fixtureCommand(fixture.build, {
      node: "node",
      npm: "npm",
      pnpm: "pnpm",
      bin: "",
    });
    fixtureCommand(fixture.smoke, {
      node: "node",
      npm: "npm",
      pnpm: "pnpm",
      bin: "",
    });
    const closure = consumerPackageClosure(pkg, packages);
    for (const [name, member] of closure) all.set(name, member);
    selections.push({ pkg, fixture, closure });
  }
  const scratch = await mkdtemp(path.join(tmpdir(), "stll-consumer-compat-"));
  try {
    const tools = await provisionConsumerTools(scratch, policy);
    const artifacts = await packConsumerArtifacts({
      root,
      scratch,
      tools,
      packages: all,
      workspacePackages: packages,
    });
    for (const selection of selections)
      for (const manager of ["npm", "pnpm"] as const)
        await runFixture({
          fixtureRoot,
          ...selection,
          artifacts,
          scratch,
          tools,
          policy,
          manager,
        });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
