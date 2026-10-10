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
import { parse, stringify } from "yaml";

import { consumerBuildApprovals } from "./consumer-build-approvals";
import {
  bunCatalogState,
  catalogState,
  pnpmWorkspaceState,
} from "./consumer-catalogs";
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
  discoverConsumerManifests,
  discoverConsumerPackages,
  parseConsumerFixtures,
  type ConsumerFixture,
  type ConsumerPackage,
} from "./consumer-compat-config";
import { assertConsumerInstalledToolBins } from "./consumer-installed-bins";
import { selectConsumerReactVersions } from "./consumer-react";
import {
  resolveConsumerReleasePack,
  consumerReleasePackArguments,
  type ConsumerReleasePack,
} from "./consumer-release-pack";
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
  await writeFile(
    path.join(wrappers, "node"),
    `#!/bin/sh\nexec ${quote(node)} "$@"\n`,
    { mode: 0o755 },
  );
  for (const [name, cli] of [
    ["npm", npm],
    ["npx", path.join(path.dirname(npm), "npx-cli.js")],
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
    bin: wrappers,
  };
};

export const provisionConsumerTools = async (
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
      ".github/workflows/*.yml",
      ".github/workflows/*.yaml",
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
      if (
        ["node_modules", ".git", "pnpm-workspace.yaml"].includes(
          path.basename(file),
        )
      )
        return false;
      if ((await lstat(file)).isSymbolicLink())
        throw new Error(`consumer staging does not accept symlinks: ${file}`);
      return true;
    },
  });
};

type StageConsumerWorkspaceOptions = {
  files: Record<string, string>;
  root: string;
  staging: string;
  packages: Map<string, ConsumerPackage>;
};
export const stageConsumerWorkspace = async ({
  files,
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
  const rootManifest = consumerPackRootManifest(packages, files);
  await writeFile(
    path.join(staging, "package.json"),
    JSON.stringify(rootManifest),
  );
  const rootSource = files["pnpm-workspace.yaml"];
  const rootCatalogs =
    rootSource === undefined
      ? bunCatalogState(rootManifest)
      : catalogState(
          pnpmWorkspaceState(rootSource, "pnpm-workspace.yaml"),
          "pnpm-workspace.yaml",
        );
  await writeFile(
    path.join(staging, "pnpm-workspace.yaml"),
    stringify({
      packages: [...directories.values()].map(
        (directory) =>
          path.relative(staging, directory).split(path.sep).join("/") || ".",
      ),
      ...rootCatalogs,
    }),
  );
  for (const [directory, manifest] of discoverConsumerManifests(files)) {
    if (directory === ".") continue;
    const file = `${directory}/pnpm-workspace.yaml`;
    const source = files[file];
    let workspace: Record<string, unknown>;
    if (source !== undefined) workspace = pnpmWorkspaceState(source, file);
    else {
      const catalogs = bunCatalogState(manifest);
      if (Object.keys(catalogs).length === 0) continue;
      const declaration = manifest["workspaces"];
      const patterns = consumerRecord(declaration)
        ? declaration["packages"]
        : declaration;
      if (
        !Array.isArray(patterns) ||
        !patterns.every((entry: unknown) => typeof entry === "string")
      )
        throw new Error(
          `catalog owner requires declared workspace packages: ${directory}`,
        );
      workspace = { packages: patterns, ...catalogs };
    }
    const destination = path.join(staging, directory);
    await mkdir(destination, { recursive: true });
    await writeFile(
      path.join(destination, "package.json"),
      JSON.stringify(manifest),
    );
    await writeFile(
      path.join(destination, "pnpm-workspace.yaml"),
      stringify(workspace),
    );
  }
  return directories;
};

export {
  assertConsumerInstalledToolBins,
  consumerReservedToolBins,
} from "./consumer-installed-bins";

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

type ProvisionConsumerReleasePackerOptions = {
  tools: ConsumerTools;
  scratch: string;
  release: ConsumerReleasePack;
};
const provisionConsumerReleasePacker = async ({
  tools,
  scratch,
  release,
}: ProvisionConsumerReleasePackerOptions) => {
  const prefix = path.join(scratch, "release-packer");
  const home = path.join(scratch, "release-packer-home");
  await mkdir(home);
  await writeFile(path.join(home, "npmrc"), "");
  const env = consumerCommandEnvironment({ tools, directory: scratch, home });
  await execute(
    tools.node,
    [
      tools.npm,
      "install",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      `${release.manager}@${release.version}`,
    ],
    { cwd: scratch, env },
  );
  const cli = path.join(
    prefix,
    "node_modules",
    release.manager,
    release.manager === "npm" ? "bin/npm-cli.js" : "pnpm",
  );
  const actual = (
    await execute(tools.node, [cli, "--version"], { cwd: scratch, env })
  ).trim();
  if (actual !== release.version)
    throw new Error(
      `release packer version mismatch: expected ${release.version}, got ${actual}`,
    );
  return cli;
};

type PackOptions = {
  files: Record<string, string>;
  root: string;
  scratch: string;
  tools: ConsumerTools;
  packages: Map<string, ConsumerPackage>;
  workspacePackages: Map<string, ConsumerPackage>;
};
export const packConsumerArtifacts = async ({
  files,
  root,
  scratch,
  tools,
  packages,
  workspacePackages,
}: PackOptions) => {
  const release = resolveConsumerReleasePack(files);
  const releaseCli = await provisionConsumerReleasePacker({
    tools,
    scratch,
    release,
  });
  const artifacts = new Map<string, string>();
  const staging = path.join(scratch, "pack-workspace");
  await mkdir(staging);
  const stagedDirectories = await stageConsumerWorkspace({
    files,
    root,
    staging,
    packages: workspacePackages,
  });
  const packHome = path.join(scratch, "pack-home");
  await mkdir(packHome);
  await writeFile(path.join(packHome, "npmrc"), "");
  for (const [index, pkg] of [...packages.values()].entries()) {
    const packed = path.join(scratch, `packed-${index}`);
    await mkdir(packed);
    const directory = stagedDirectories.get(pkg.name);
    if (!directory)
      throw new Error(`missing pack workspace member: ${pkg.name}`);
    await execute(
      tools.node,
      [
        releaseCli,
        ...consumerReleasePackArguments({ packer: release, directory: packed }),
      ],
      {
        cwd: directory,
        env: consumerCommandEnvironment({ tools, directory, home: packHome }),
      },
    );
    const artifact = await packFilename(packed);
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
        !/^(?:npm_config_|pnpm_|yarn_|corepack_)/i.test(key) &&
        key !== "NODE_PATH" &&
        key !== "NODE_OPTIONS",
    ),
  );
  Object.assign(env, {
    PATH: `${tools.bin}${path.delimiter}${path.join(directory, "node_modules/.bin")}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    HOME: home,
    npm_config_cache: path.join(home, "npm-cache"),
    npm_config_userconfig: path.join(home, "npmrc"),
    npm_config_registry: "https://registry.npmjs.org/",
    // Project packageManager fields cannot replace the verified consumer/release tools.
    pnpm_config_pm_on_fail: "ignore",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENV_FILE: "0",
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
      ? [
          tools.node,
          tools.npm,
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ]
      : [
          tools.node,
          tools.pnpm,
          "pm",
          "install",
          "--ignore-scripts",
          "--no-frozen-lockfile",
          "--store-dir",
          path.join(home, "pnpm-store"),
        ];
  return [
    install,
    manager === "pnpm"
      ? [tools.node, tools.pnpm, "pm", "rebuild", "--pending"]
      : [tools.node, tools.npm, "rebuild"],
    [
      tools.node,
      path.join(directory, "node_modules/typescript/bin/tsc"),
      "--noEmit",
    ],
    fixtureCommand(fixture.build, tools),
    fixtureCommand(fixture.smoke, tools),
  ];
};

export const installConsumerFixtureDependencies = async (
  options: ConsumerFixtureCommandOptions,
) => {
  const env = consumerCommandEnvironment(options);
  const commands = consumerFixtureCommands(options);
  for (const [index, argv] of commands.slice(0, 2).entries()) {
    const executable = argv.at(0);
    if (!executable) throw new Error("missing consumer dependency command");
    process.stdout.write(
      await execute(executable, argv.slice(1), { cwd: options.directory, env }),
    );
    // Installation cannot execute scripts; validate bins before any lifecycle execution.
    await assertConsumerInstalledToolBins(options.directory);
    if (index !== 0) continue;
    const manifestFile = path.join(options.directory, "package.json");
    const manifest: unknown = JSON.parse(await readFile(manifestFile, "utf8"));
    if (!consumerRecord(manifest))
      throw new Error("invalid consumer fixture manifest");
    const lockSource = await readFile(
      path.join(
        options.directory,
        options.manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml",
      ),
      "utf8",
    );
    const lock: unknown =
      options.manager === "npm" ? JSON.parse(lockSource) : parse(lockSource);
    const approvals = consumerBuildApprovals({
      manifest,
      lock,
      manager: options.manager,
    });
    if (options.manager === "npm") {
      // Explicit identities also prevent older manager defaults from rebuilding
      // unapproved transitive packages or the root fixture lifecycle.
      const rebuild = commands.at(1);
      if (!rebuild) throw new Error("missing consumer rebuild command");
      rebuild.push(...Object.keys(approvals));
      if (Object.keys(approvals).length === 0) break;
      await writeFile(
        manifestFile,
        `${JSON.stringify({ ...manifest, allowScripts: approvals }, null, 2)}\n`,
      );
    } else {
      const workspaceFile = path.join(options.directory, "pnpm-workspace.yaml");
      const workspace: unknown = parse(await readFile(workspaceFile, "utf8"));
      if (!consumerRecord(workspace))
        throw new Error("invalid generated consumer workspace");
      await writeFile(
        workspaceFile,
        stringify({ ...workspace, allowBuilds: approvals }),
      );
    }
  }
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
    const needsDom = typeof peers["react-dom"] === "string" || needsReactDom;
    const bindings = selectConsumerReactVersions({
      reactRange: peers["react"],
      reactVersions: await registryMetadata("react"),
      dom: needsDom
        ? {
            range:
              typeof peers["react-dom"] === "string"
                ? peers["react-dom"]
                : undefined,
            versions: await registryMetadata("react-dom"),
          }
        : undefined,
    });
    Object.assign(reactBindings, bindings);
    process.stdout.write(
      `${pkg.name}: ${manager} React ${bindings.react}${bindings["react-dom"] === undefined ? "" : ` / ReactDOM ${bindings["react-dom"]}`}\n`,
    );
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
  const options = { manager, tools, directory, home, fixture };
  await installConsumerFixtureDependencies(options);
  const installed = await jsonFile(
    path.join(directory, "node_modules/typescript/package.json"),
  );
  if (installed["version"] !== policy.consumerTypescript)
    throw new Error("installed consumer TypeScript does not match policy");
  const env = consumerCommandEnvironment(options);
  for (const argv of consumerFixtureCommands(options).slice(2)) {
    await assertConsumerInstalledToolBins(directory);
    const executable = argv.at(0);
    if (!executable) throw new Error("missing consumer command");
    process.stdout.write(
      await execute(executable, argv.slice(1), { cwd: directory, env }),
    );
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
  const files = await trackedManifests(root);
  const packages = discoverConsumerPackages(files);
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
    const closure = consumerPackageClosure({ selected: pkg, packages, files });
    for (const [name, member] of closure) all.set(name, member);
    selections.push({ pkg, fixture, closure });
  }
  resolveConsumerReleasePack(files);
  const scratch = await mkdtemp(path.join(tmpdir(), "stll-consumer-compat-"));
  try {
    const tools = await provisionConsumerTools(scratch, policy);
    const artifacts = await packConsumerArtifacts({
      files,
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
