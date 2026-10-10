import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { satisfies, valid, validRange } from "semver";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";

import {
  changedPackageTool,
  changedRecord,
  parseChangedJson,
  parseChangedLock,
  toolchainChangedTools,
  type ChangedLock,
  type ToolchainChangedTool,
} from "./toolchain-changed-locks";
import {
  isDockerDefinitionPath,
  githubAutomationFileKind,
  isMiseConfigPath,
} from "./toolchain-inputs";
import { workspaceContains } from "./toolchain-workspaces";

export type ToolchainChanges =
  | {
      status: "compared";
      changed: boolean;
      tools: ToolchainChangedTool[];
      current: { bun: string[]; typescript: string[] };
    }
  | {
      status: "unreadable";
      changed: true;
      tools: ToolchainChangedTool[];
      error: string;
    };

const git = promisify(execFile);
const trackedInput = (file: string) => {
  if (
    file.split("/").some((part) => part === "node_modules" || part === "vendor")
  )
    return false;
  const name = path.posix.basename(file);
  return (
    [
      "package.json",
      "bun.lock",
      "bun.lockb",
      "pnpm-lock.yaml",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-workspace.yaml",
      ".node-version",
      ".nvmrc",
      ".bun-version",
      ".tool-versions",
      "toolchain.json",
    ].includes(name) ||
    isMiseConfigPath(file) ||
    githubAutomationFileKind(file) !== undefined ||
    isDockerDefinitionPath(file)
  );
};
type TreeEntry = { mode: string; oid: string };
type GitSnapshot = {
  entries: Map<string, TreeEntry>;
  blobs: Map<string, string>;
};
const readTree = async ({ repo, ref }: { repo: string; ref: string }) => {
  const { stdout } = await git("git", ["ls-tree", "-rz", "--full-tree", ref], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const entries = new Map<string, TreeEntry>();
  for (const entry of stdout.split("\0")) {
    if (entry === "") continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error("Invalid Git tree response");
    const file = entry.slice(tab + 1);
    const [mode, type, oid] = entry.slice(0, tab).split(" ");
    if (type !== "blob" && !trackedInput(file)) continue;
    if (type !== "blob" || !mode || !oid || !/^[a-f0-9]{40,64}$/.test(oid))
      throw new Error("Unreadable tracked toolchain input");
    entries.set(file, { mode, oid });
  }
  return entries;
};
const readBlobs = async ({ repo, oids }: { repo: string; oids: string[] }) => {
  if (oids.length === 0) return new Map<string, string>();
  const data = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], {
      cwd: repo,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 128 * 1024 * 1024) {
        child.kill();
        reject(new Error("Toolchain Git snapshot exceeds the read limit"));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error("Unable to read Git snapshot blobs")),
    );
    child.stdin.on("error", reject);
    child.stdin.end(`${oids.join("\n")}\n`);
  });
  const blobs = new Map<string, string>();
  let offset = 0;
  for (const oid of oids) {
    const end = data.indexOf(10, offset);
    if (end < 0) throw new Error("Invalid Git blob response");
    const [actual, type, length] = data
      .subarray(offset, end)
      .toString("utf8")
      .split(" ");
    const size = Number(length);
    if (
      actual !== oid ||
      type !== "blob" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      end + size + 1 >= data.length
    )
      throw new Error("Unreadable Git blob response");
    offset = end + 1;
    blobs.set(oid, data.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  if (offset !== data.length) throw new Error("Unexpected Git blob response");
  return blobs;
};
const snapshotText = ({
  snapshot,
  file,
  visited = new Set<string>(),
}: {
  snapshot: GitSnapshot;
  file: string;
  visited?: Set<string>;
}): string => {
  if (visited.has(file))
    throw new Error("Cyclic tracked toolchain file reference");
  visited.add(file);
  const entry = snapshot.entries.get(file);
  const text = entry && snapshot.blobs.get(entry.oid);
  if (!entry || text === undefined)
    throw new Error(`Missing tracked toolchain input: ${file}`);
  if (entry.mode !== "120000") return text;
  const target = path.posix.normalize(
    path.posix.join(path.posix.dirname(file), text),
  );
  if (
    path.posix.isAbsolute(text) ||
    target === ".." ||
    target.startsWith("../")
  )
    throw new Error("Toolchain file reference leaves the tracked snapshot");
  return snapshotText({ snapshot, file: target, visited });
};
/** Read declared selector files too, without executing workflows or inspecting installed tools. */
const selectorFiles = (snapshot: GitSnapshot) => {
  const files = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!changedRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (key.toLowerCase() !== "bun-version-file") {
        visit(entry);
        continue;
      }
      if (
        typeof entry !== "string" ||
        entry.trim() === "" ||
        entry.includes("${{") ||
        path.posix.isAbsolute(entry) ||
        entry.split("/").includes("..")
      )
        throw new Error("Unclassifiable Bun version-file declaration");
      const file = path.posix.normalize(entry);
      if (
        file === "." ||
        file
          .split("/")
          .some((part) => part === "vendor" || part === "node_modules")
      )
        throw new Error("Bun version-file leaves the tracked toolchain scope");
      files.add(file);
    }
  };
  for (const file of snapshot.entries.keys()) {
    if (githubAutomationFileKind(file) === undefined) continue;
    const document = parseDocument(snapshotText({ snapshot, file }));
    if (document.errors.length > 0)
      throw new Error("Unreadable workflow declaration");
    const value: unknown = document.toJS({ maxAliasCount: 100 });
    visit(value);
  }
  return files;
};

const readSnapshots = async ({
  repo,
  trees,
}: {
  repo: string;
  trees: Map<string, TreeEntry>[];
}) => {
  const selected = trees.map(
    (tree) => new Map([...tree].filter(([file]) => trackedInput(file))),
  );
  const blobs = new Map<string, string>();
  for (;;) {
    const pending = [
      ...new Set(
        selected.flatMap((entries) =>
          [...entries.values()].map((entry) => entry.oid),
        ),
      ),
    ].filter((oid) => !blobs.has(oid));
    for (const [oid, text] of await readBlobs({ repo, oids: pending }))
      blobs.set(oid, text);
    let expanded = false;
    for (let index = 0; index < selected.length; index += 1) {
      const entries = selected.at(index);
      const tree = trees.at(index);
      if (!entries || !tree) throw new Error("Missing Git tree");
      const required = new Set<string>();
      for (const [file, entry] of entries) {
        if (entry.mode !== "120000") continue;
        const text = blobs.get(entry.oid);
        if (text === undefined) throw new Error("Missing tracked symlink");
        const target = path.posix.normalize(
          path.posix.join(path.posix.dirname(file), text),
        );
        if (
          path.posix.isAbsolute(text) ||
          target === ".." ||
          target.startsWith("../")
        )
          throw new Error("Toolchain symlink leaves the tracked tree");
        required.add(target);
      }
      // Resolve symlink closure before reading workflow YAML.
      const unresolvedLinks = [...required].some((file) => !entries.has(file));
      if (!unresolvedLinks)
        for (const file of selectorFiles({ entries, blobs }))
          required.add(file);
      for (const file of required) {
        if (entries.has(file)) continue;
        const entry = tree.get(file);
        if (!entry)
          throw new Error(`Missing tracked toolchain selector file: ${file}`);
        entries.set(file, entry);
        expanded = true;
      }
    }
    if (!expanded) return selected.map((entries) => ({ entries, blobs }));
  }
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return JSON.stringify(value.map(stableJson));
  if (changedRecord(value))
    return JSON.stringify(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableJson(item)]),
    );
  return JSON.stringify(value) ?? "undefined";
};
const inventory = () =>
  ({
    bun: new Set<string>(),
    node: new Set<string>(),
    typescript: new Set<string>(),
    oxlint: new Set<string>(),
    "oxlint-tsgolint": new Set<string>(),
    oxfmt: new Set<string>(),
    shared: new Set<string>(),
  }) satisfies Record<ToolchainChangedTool, Set<string>>;
const installedFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const;
const exactBun = (value: string) => {
  const version = value.trim().replace(/^v/, "");
  const exact = valid(version);
  if (exact === null)
    throw new Error("Bun runtime declaration is not an exact version");
  return exact;
};
const packageTarget = ({
  name,
  specifier,
}: {
  name: string;
  specifier: string;
}) => {
  if (!specifier.startsWith("npm:")) return name;
  const match = /^npm:((?:@[^/@\s]+\/)?[^/@\s]+)(?:@.*)?$/.exec(specifier);
  const target = match?.[1];
  if (target === undefined)
    throw new Error("Unclassifiable npm alias declaration");
  return target;
};
const directoryDepth = (directory: string) =>
  directory.split("/").filter((part) => part !== "." && part !== "").length;
const isAncestor = (directory: string, child: string) => {
  const relative = path.posix.relative(directory, child);
  return (
    relative !== ".." &&
    !relative.startsWith("../") &&
    !path.posix.isAbsolute(relative)
  );
};
type BoundResolutionOptions = {
  lockFile: string;
  lock: ChangedLock;
  file: string;
  manifest: Record<string, unknown>;
  dependency: string;
  name: string;
};
const boundResolution = ({
  lockFile,
  lock,
  file,
  manifest,
  dependency,
  name,
}: BoundResolutionOptions) => {
  const directory =
    path.posix.relative(
      path.posix.dirname(lockFile),
      path.posix.dirname(file),
    ) || ".";
  const candidates = lock.resolutions.filter(
    (item) => item.name === name || item.dependency === dependency,
  );
  if (path.posix.basename(lockFile) === "pnpm-lock.yaml") {
    const value = lock.importers[directory]?.[dependency];
    if (value === undefined)
      throw new Error(`Missing resolved importer: ${file}:${dependency}`);
    const descriptor = value.replace(/^npm:/, "");
    const version = descriptor.startsWith(`${name}@`)
      ? descriptor.slice(name.length + 1)
      : descriptor;
    const resolvedVersion = version.split("(").at(0);
    const matched = candidates.filter(
      (item) => item.version === resolvedVersion,
    );
    const versions = new Set(
      matched.map((item) => `${item.name}@${item.version}`),
    );
    if (versions.size === 1) return matched;
    throw new Error(`Ambiguous resolved importer: ${file}:${dependency}`);
  }
  const locations: string[] = [];
  if (path.posix.basename(lockFile) === "bun.lock") {
    if (
      directory !== "." &&
      typeof manifest["name"] !== "string" &&
      candidates.length > 1
    )
      throw new Error(
        `Ambiguous Bun workspace resolution: ${file}:${dependency}`,
      );
    if (directory !== "." && typeof manifest["name"] === "string")
      locations.push(`${manifest["name"]}/${dependency}`);
    locations.push(dependency);
  } else {
    let current = directory;
    for (;;) {
      locations.push(path.posix.join(current, "node_modules", dependency));
      if (current === ".") break;
      current = path.posix.dirname(current);
    }
  }
  for (const location of locations) {
    const matched = candidates.filter((item) => item.location === location);
    if (matched.length === 1) return matched;
    if (matched.length > 1)
      throw new Error(`Ambiguous lock location: ${file}:${dependency}`);
  }
  throw new Error(
    `Missing resolved toolchain dependency: ${file}:${dependency}`,
  );
};
type ParsedSnapshot = {
  tools: ReturnType<typeof inventory>;
  current: { bun: string[]; typescript: string[] };
};
const parseSnapshot = (snapshot: GitSnapshot): ParsedSnapshot => {
  const tools = inventory();
  const bunVersions = new Set<string>();
  const bunRanges: string[] = [];
  const manifests = new Map<string, Record<string, unknown>>();
  const locks = new Map<string, ChangedLock>();
  const workspacePatterns = new Map<string, unknown>();
  const typescript = new Set<string>();
  const bunFiles = selectorFiles(snapshot);
  const addBun = (value: string) => {
    const version = exactBun(value);
    bunVersions.add(version);
    tools.bun.add(version);
  };
  const catalogs = (file: string, value: Record<string, unknown>) => {
    for (const field of ["catalog", "catalogs"]) {
      if (value[field] === undefined) continue;
      // Catalog names and aliases need their owner's lockfile to classify; unknown
      // entries conservatively force parity through the shared category.
      tools.shared.add(`${file}:${field}:${stableJson(value[field])}`);
      const visit = (entry: unknown, at: string) => {
        if (!changedRecord(entry)) return;
        for (const [name, specifier] of Object.entries(entry)) {
          const target =
            typeof specifier === "string"
              ? packageTarget({ name, specifier })
              : name;
          if (changedPackageTool(target) === "typescript")
            tools.typescript.add(
              `${file}:${at}:${name}:${stableJson(specifier)}`,
            );
          visit(specifier, `${at}:${name}`);
        }
      };
      visit(value[field], field);
    }
  };
  for (const file of snapshot.entries.keys()) {
    const text = snapshotText({ snapshot, file });
    const name = path.posix.basename(file);
    if (bunFiles.has(file)) tools.bun.add(`selector-file:${file}:${text}`);
    if (name === "package.json") {
      const manifest = parseChangedJson(text);
      if (!changedRecord(manifest))
        throw new Error(`Invalid tracked manifest: ${file}`);
      manifests.set(file, manifest);
      catalogs(file, manifest);
      if (changedRecord(manifest["workspaces"]))
        catalogs(`${file}:workspaces`, manifest["workspaces"]);
    } else if (name === "pnpm-workspace.yaml") {
      const document = parseDocument(text);
      if (document.errors.length > 0)
        throw new Error("Invalid pnpm workspace YAML");
      const workspace: unknown = document.toJS({ maxAliasCount: 100 });
      if (!changedRecord(workspace))
        throw new Error("Invalid pnpm workspace configuration");
      workspacePatterns.set(path.posix.dirname(file), workspace["packages"]);
      catalogs(file, workspace);
    } else if (
      [
        "bun.lock",
        "pnpm-lock.yaml",
        "package-lock.json",
        "npm-shrinkwrap.json",
      ].includes(name)
    )
      locks.set(file, parseChangedLock({ file, text }));
    else if (name === "bun.lockb") {
      if (
        !snapshot.entries.has(
          path.posix.join(path.posix.dirname(file), "bun.lock"),
        )
      )
        throw new Error(
          "Binary Bun lockfile cannot be resolved without executing Bun",
        );
    } else if (name === ".bun-version") addBun(text.trim());
    else if (name === ".node-version" || name === ".nvmrc")
      tools.node.add(`${file}:${text.trim()}`);
    else if (name === "toolchain.json") {
      const policy = parseChangedJson(text);
      if (!changedRecord(policy))
        throw new Error("Invalid shared toolchain policy");
      tools.shared.add(`${file}:${stableJson(policy)}`);
      if (typeof policy["bun"] === "string") addBun(policy["bun"]);
    } else if (name === ".tool-versions") {
      tools.bun.add(`${file}:${text}`);
      tools.typescript.add(`${file}:${text}`);
      for (const line of text.split(/\r?\n/)) {
        const [tool, ...versions] = line.trim().split(/\s+/);
        const value = versions.join(" ").split("#")[0]?.trim();
        if (tool === "bun" && value) addBun(value);
        if ((tool === "node" || tool === "nodejs") && value)
          tools.node.add(`${file}:${value}`);
      }
    } else if (isMiseConfigPath(file)) {
      tools.bun.add(`${file}:${text}`);
      tools.typescript.add(`${file}:${text}`);
      const parsed: unknown = parseToml(text);
      if (changedRecord(parsed) && changedRecord(parsed["tools"])) {
        for (const [tool, selector] of Object.entries(parsed["tools"])) {
          const value = changedRecord(selector)
            ? selector["version"]
            : selector;
          const values = Array.isArray(value) ? value : [value];
          if (tool === "bun" || tool === "core:bun")
            for (const version of values) {
              if (typeof version !== "string")
                throw new Error("Unresolved mise Bun selector");
              addBun(version);
            }
          if (["node", "nodejs", "core:node"].includes(tool))
            tools.node.add(`${file}:${stableJson(values)}`);
        }
      }
    } else if (githubAutomationFileKind(file) !== undefined) {
      tools.shared.add(`${file}:${text}`);
      tools.bun.add(`${file}:${text}`);
      tools.typescript.add(`${file}:${text}`);
    } else if (isDockerDefinitionPath(file)) {
      tools.shared.add(`${file}:${text}`);
      tools.node.add(`${file}:${text}`);
      tools.bun.add(`${file}:${text}`);
      tools.typescript.add(`${file}:${text}`);
      for (const match of text.matchAll(
        /^\s*FROM\s+(?:--[^\s]+\s+)*oven\/bun:([\w.+-]+)/gim,
      )) {
        const tag = match[1];
        if (tag) addBun(tag.replace(/-(?:alpine|slim|debian)$/, ""));
      }
    }
  }
  const activeManifest = (file: string) => {
    if (file === "package.json") return true;
    const directory = path.posix.dirname(file);
    if (
      [
        "bun.lock",
        "pnpm-lock.yaml",
        "package-lock.json",
        "npm-shrinkwrap.json",
      ].some((name) => locks.has(path.posix.join(directory, name)))
    )
      return true;
    const owners = [...manifests]
      .filter(
        ([ownerFile, owner]) =>
          owner["workspaces"] !== undefined &&
          isAncestor(path.posix.dirname(ownerFile), directory),
      )
      .map(([ownerFile, owner]) => ({
        directory: path.posix.dirname(ownerFile),
        patterns: changedRecord(owner["workspaces"])
          ? owner["workspaces"]["packages"]
          : owner["workspaces"],
      }));
    const pnpmOwner = [...workspacePatterns]
      .filter(([ownerDirectory]) => isAncestor(ownerDirectory, directory))
      .sort(([a], [b]) => directoryDepth(b) - directoryDepth(a))
      .at(0);
    if (pnpmOwner)
      return workspaceContains({
        directory: pnpmOwner[0],
        file,
        patterns: pnpmOwner[1],
        rootMembership: "implicit",
      });
    const owner = owners
      .sort((a, b) => directoryDepth(b.directory) - directoryDepth(a.directory))
      .at(0);
    if (owner)
      return workspaceContains({
        directory: owner.directory,
        file,
        patterns: owner.patterns,
        rootMembership: "implicit",
      });
    for (const [lockFile, lock] of locks) {
      const relative =
        path.posix.relative(path.posix.dirname(lockFile), directory) || ".";
      if (Object.hasOwn(lock.importers, relative)) return true;
    }
    return false;
  };
  for (const [file, manifest] of manifests) {
    const active = activeManifest(file);
    const manager = manifest["packageManager"];
    if (typeof manager === "string" && manager.startsWith("bun@"))
      addBun(manager.slice(4));
    const engines = manifest["engines"];
    if (changedRecord(engines)) {
      if (typeof engines["node"] === "string")
        tools.node.add(`${file}:${engines["node"]}`);
      if (typeof engines["bun"] === "string") {
        if (!validRange(engines["bun"]))
          throw new Error("Invalid Bun engine selector");
        bunRanges.push(engines["bun"]);
        tools.bun.add(`${file}:engines.bun:${engines["bun"]}`);
        if (valid(engines["bun"]) !== null) addBun(engines["bun"]);
      }
    }
    // Peer declarations do not install a compiler. Excluded manifests have no
    // modeled workspace lock owner, so preserve their declarations conservatively.
    for (const field of active
      ? ["peerDependencies"]
      : [...installedFields, "peerDependencies"]) {
      const declarations = manifest[field];
      if (declarations === undefined) continue;
      if (!changedRecord(declarations))
        throw new Error(`Invalid toolchain declarations: ${file}:${field}`);
      for (const [dependency, specifier] of Object.entries(declarations)) {
        if (typeof specifier !== "string")
          throw new Error(
            `Unclassifiable toolchain declaration: ${file}:${dependency}`,
          );
        const tool =
          changedPackageTool(packageTarget({ name: dependency, specifier })) ??
          changedPackageTool(dependency);
        if (tool !== undefined)
          tools[tool].add(`${file}:${field}:${dependency}:${specifier}`);
      }
    }
    if (!active) continue;
    const ownName = manifest["name"];
    const ownVersion = manifest["version"];
    if (
      typeof ownName === "string" &&
      changedPackageTool(ownName) === "shared" &&
      typeof ownVersion === "string"
    )
      tools.shared.add(`${ownName}@${ownVersion}`);
    for (const field of installedFields) {
      const dependencies = manifest[field];
      if (dependencies === undefined) continue;
      if (!changedRecord(dependencies))
        throw new Error(`Invalid manifest dependency table: ${file}`);
      for (const [dependency, specifier] of Object.entries(dependencies)) {
        if (typeof specifier !== "string")
          throw new Error(`Invalid dependency specifier: ${file}`);
        const name = packageTarget({ name: dependency, specifier });
        const tool = changedPackageTool(name) ?? changedPackageTool(dependency);
        if (tool === undefined) continue;
        const candidates = [...locks]
          .filter(([lockFile]) => {
            const relative = path.posix.relative(
              path.posix.dirname(lockFile),
              path.posix.dirname(file),
            );
            return relative !== ".." && !relative.startsWith("../");
          })
          .sort(
            ([a], [b]) =>
              directoryDepth(path.posix.dirname(b)) -
              directoryDepth(path.posix.dirname(a)),
          );
        const nearest = candidates.at(0);
        if (!nearest)
          throw new Error(`Missing toolchain lockfile: ${file}:${dependency}`);
        const lockDirectory = path.posix.dirname(nearest[0]);
        const owner = [...manifests]
          .filter(
            ([ownerFile, ownerManifest]) =>
              typeof ownerManifest["packageManager"] === "string" &&
              isAncestor(
                path.posix.dirname(ownerFile),
                path.posix.dirname(file),
              ),
          )
          .sort(
            ([a], [b]) =>
              directoryDepth(path.posix.dirname(b)) -
              directoryDepth(path.posix.dirname(a)),
          )
          .at(0);
        const manager = owner?.[1]["packageManager"];
        const sameOwner = candidates.filter(
          ([candidate]) => path.posix.dirname(candidate) === lockDirectory,
        );
        const selectedLocks = sameOwner.filter(([candidate]) => {
          if (typeof manager !== "string") return true;
          const name = path.posix.basename(candidate);
          if (manager.startsWith("bun@")) return name === "bun.lock";
          if (manager.startsWith("pnpm@")) return name === "pnpm-lock.yaml";
          if (manager.startsWith("npm@"))
            return (
              name === "package-lock.json" || name === "npm-shrinkwrap.json"
            );
          return false;
        });
        const selected = selectedLocks.at(0);
        if (selectedLocks.length !== 1 || !selected)
          throw new Error(
            `Ambiguous or missing effective lockfile: ${file}:${dependency}`,
          );
        const [lockFile, lock] = selected;
        const resolved = boundResolution({
          lockFile,
          lock,
          file,
          manifest,
          dependency,
          name,
        });
        const range = specifier.startsWith("npm:")
          ? specifier.slice(specifier.lastIndexOf("@") + 1)
          : specifier;
        if (
          validRange(range) &&
          !resolved.some(
            (item) =>
              valid(item.version) !== null && satisfies(item.version, range),
          )
        )
          throw new Error(
            `Toolchain lock resolution does not satisfy manifest: ${file}:${dependency}`,
          );
        for (const item of resolved)
          tools[tool].add(
            `${file}:${dependency}=>${item.location}:${item.name}@${item.version}`,
          );
      }
    }
  }
  for (const [lockFile, lock] of locks) {
    for (const item of lock.resolutions) {
      tools[item.tool].add(
        `${lockFile}:${item.location}:${item.dependency}=>${item.name}@${item.version}`,
      );
      if (item.tool === "typescript")
        typescript.add(`${item.name}@${item.version}`);
    }
    if (path.posix.basename(lockFile) !== "pnpm-lock.yaml") continue;
    for (const [directory, dependencies] of Object.entries(lock.importers))
      for (const [dependency, version] of Object.entries(dependencies)) {
        const tool =
          changedPackageTool(
            packageTarget({
              name: dependency,
              specifier: version.startsWith("npm:")
                ? version
                : `npm:${version}`,
            }),
          ) ??
          changedPackageTool(dependency) ??
          lock.resolutions.find((item) => item.dependency === dependency)?.tool;
        if (tool !== undefined)
          tools[tool].add(
            `${lockFile}:importer:${directory}:${dependency}:${version}`,
          );
      }
  }
  if (bunVersions.size > 1)
    throw new Error("Conflicting Bun runtime versions in tracked declarations");
  const bun = [...bunVersions].sort();
  if (bunRanges.length > 0 && bun.length === 0)
    throw new Error("Bun engine range has no exact runtime declaration");
  for (const range of bunRanges)
    if (!bun.every((version) => satisfies(version, range)))
      throw new Error("Bun runtime does not satisfy tracked engine range");
  return { tools, current: { bun, typescript: [...typescript].sort() } };
};

export const detectToolchainChanges = async ({
  repo,
  since,
}: {
  repo: string;
  since: string;
}): Promise<ToolchainChanges> => {
  try {
    const refs = await Promise.all(
      [since, "HEAD"].map(async (ref) => {
        const { stdout } = await git(
          "git",
          ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
          { cwd: repo, encoding: "utf8" },
        );
        const oid = stdout.trim();
        if (!/^[a-f0-9]{40,64}$/.test(oid))
          throw new Error("Invalid Git commit response");
        return oid;
      }),
    );
    const previousRef = refs.at(0);
    const currentRef = refs.at(1);
    if (!previousRef || !currentRef)
      throw new Error("Missing Git comparison snapshot");
    const [previousEntries, currentEntries] = await Promise.all([
      readTree({ repo, ref: previousRef }),
      readTree({ repo, ref: currentRef }),
    ]);
    const snapshots = await readSnapshots({
      repo,
      trees: [previousEntries, currentEntries],
    });
    const previousSnapshot = snapshots.at(0);
    const currentSnapshot = snapshots.at(1);
    if (!previousSnapshot || !currentSnapshot)
      throw new Error("Missing toolchain snapshot");
    const previous = parseSnapshot(previousSnapshot);
    const current = parseSnapshot(currentSnapshot);
    const tools = toolchainChangedTools.filter(
      (tool) =>
        stableJson([...previous.tools[tool]].sort()) !==
        stableJson([...current.tools[tool]].sort()),
    );
    return {
      status: "compared",
      changed: tools.length > 0,
      tools,
      current: current.current,
    };
  } catch (error) {
    return {
      status: "unreadable",
      changed: true,
      tools: [...toolchainChangedTools],
      error:
        error instanceof Error
          ? error.message
          : "Unreadable toolchain Git snapshot",
    };
  }
};
