import path from "node:path";
import { fileURLToPath } from "node:url";

import { packageMode, parseArtifactSource } from "./publish-artifact-parser";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const javascript = /\.(?:js|mjs|cjs)$/iu;
const opaque = /\.(?:json|node)$/u;
const declaration = /\.d\.[cm]?ts$/iu;

type PackedRuntimeImportsOptions = {
  members: ReadonlySet<string>;
  readSource: (file: string) => Promise<string>;
  assertRegular: (file: string) => Promise<void>;
};

const packagePath = (file: string) => {
  const normalized = path.posix.normalize(file);
  if (
    (normalized !== "package" && !normalized.startsWith("package/")) ||
    file.includes("\\")
  )
    throw new Error(`Runtime import escapes the packed package: ${file}`);
  return normalized;
};

const targets = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(targets);
  if (!record(value)) throw new Error("Invalid packed runtime entry target");
  return Object.entries(value).flatMap(([key, entry]) =>
    key === "types" || key === "typings" ? [] : targets(entry),
  );
};

const identifier = (value: unknown) =>
  record(value) &&
  value["type"] === "Identifier" &&
  typeof value["name"] === "string"
    ? value["name"]
    : undefined;
const literal = (value: unknown) =>
  record(value) &&
  value["type"] === "Literal" &&
  typeof value["value"] === "string"
    ? value["value"]
    : undefined;
const nodes = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.flatMap(nodes);
  return record(value) && typeof value["type"] === "string" ? [value] : [];
};
const children = (node: Record<string, unknown>) =>
  Object.values(node).flatMap(nodes);
const patternNames = (value: unknown): string[] => {
  const name = identifier(value);
  if (name !== undefined) return [name];
  if (!record(value)) return [];
  switch (value["type"]) {
    case "ObjectPattern":
      return nodes(value["properties"]).flatMap((property) =>
        patternNames(
          property["type"] === "RestElement"
            ? property["argument"]
            : property["value"],
        ),
      );
    case "ArrayPattern":
      return nodes(value["elements"]).flatMap(patternNames);
    case "RestElement":
      return patternNames(value["argument"]);
    case "AssignmentPattern":
      return patternNames(value["left"]);
    default:
      return [];
  }
};
type Binding = "other" | "require" | "factory" | "module";
type Scope = Map<string, Binding>;
const binding = (scopes: readonly Scope[], name: string) => {
  for (const scope of scopes.toReversed()) {
    const found = scope.get(name);
    if (found !== undefined) return found;
  }
  return undefined;
};
const functionNode = (node: Record<string, unknown>) =>
  [
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
  ].includes(String(node["type"]));

type StaticImport = { specifier: string; mode: "import" | "require" };
/** Read syntax only: never evaluate package code or computed loader arguments. */
const staticImports = (
  tree: unknown,
  mode: "script" | "module",
): StaticImport[] => {
  const result: StaticImport[] = [];
  const walk = (node: Record<string, unknown>, scopes: readonly Scope[]) => {
    const kind = node["type"];
    if (
      kind === "Program" ||
      kind === "BlockStatement" ||
      functionNode(node) ||
      kind === "CatchClause" ||
      kind === "ForStatement" ||
      kind === "ForOfStatement" ||
      kind === "ForInStatement"
    ) {
      const local: Scope = new Map();
      const bind = (pattern: unknown) => {
        for (const name of patternNames(pattern)) local.set(name, "other");
      };
      const bindVariable = (
        entry: Record<string, unknown>,
        declarationKind: unknown,
      ) => {
        if (
          declarationKind === "var" &&
          node["type"] === "BlockStatement" &&
          node !== root
        )
          return;
        for (const name of patternNames(entry["id"])) {
          // An uninitialized var redeclares, but does not replace, a CJS parameter.
          if (
            mode === "script" &&
            node === root &&
            declarationKind === "var" &&
            entry["init"] === null &&
            (name === "require" || name === "module")
          )
            continue;
          local.set(name, "other");
        }
      };
      if (functionNode(node)) {
        bind(node["id"]);
        for (const parameter of nodes(node["params"])) bind(parameter);
      }
      if (kind === "CatchClause") bind(node["param"]);
      const statements =
        kind === "Program" || kind === "BlockStatement"
          ? nodes(node["body"])
          : children(node);
      const declarations: Record<string, unknown>[] = [];
      for (const statement of statements) {
        if (statement["type"] === "VariableDeclaration") {
          for (const entry of nodes(statement["declarations"])) {
            bindVariable(entry, statement["kind"]);
            declarations.push(entry);
          }
        } else if (
          statement["type"] === "FunctionDeclaration" ||
          statement["type"] === "ClassDeclaration"
        )
          bind(statement["id"]);
        else if (statement["type"] === "ImportDeclaration") {
          for (const specifier of nodes(statement["specifiers"])) {
            const name = identifier(specifier["local"]);
            if (name === undefined) continue;
            local.set(
              name,
              ["node:module", "module"].includes(
                literal(statement["source"]) ?? "",
              ) && identifier(specifier["imported"]) === "createRequire"
                ? "factory"
                : "other",
            );
          }
        }
      }
      // `var` declarations shadow throughout their function, including nested blocks.
      if (functionNode(node) || kind === "Program" || node === root) {
        const hoisted = (entry: Record<string, unknown>) => {
          if (functionNode(entry)) return;
          if (
            entry["type"] === "VariableDeclaration" &&
            entry["kind"] === "var"
          )
            for (const declaration of nodes(entry["declarations"])) {
              bindVariable(declaration, "var");
              if (!declarations.includes(declaration))
                declarations.push(declaration);
            }
          for (const child of children(entry)) hoisted(child);
        };
        for (const statement of statements) hoisted(statement);
      }
      const nested = [...scopes, local];
      for (const entry of declarations) {
        const name = identifier(entry["id"]);
        const initial = entry["init"];
        if (!record(initial)) continue;
        if (
          initial["type"] === "CallExpression" &&
          identifier(initial["callee"]) === "require" &&
          binding(nested, "require") === "require" &&
          ["node:module", "module"].includes(
            literal(nodes(initial["arguments"]).at(0)) ?? "",
          ) &&
          record(entry["id"]) &&
          entry["id"]["type"] === "ObjectPattern"
        ) {
          for (const property of nodes(entry["id"]["properties"])) {
            const factoryName = identifier(property["value"]);
            if (
              identifier(property["key"]) === "createRequire" &&
              factoryName !== undefined
            )
              local.set(factoryName, "factory");
          }
        }
        if (name === undefined) continue;
        const alias = identifier(initial);
        if (alias !== undefined && binding(nested, alias) === "require")
          local.set(name, "require");
        const callee = identifier(initial["callee"]);
        if (
          initial["type"] === "CallExpression" &&
          callee !== undefined &&
          binding(nested, callee) === "factory"
        ) {
          const argument = nodes(initial["arguments"]).at(0);
          const object = argument?.["object"];
          const importMeta =
            record(object) &&
            object["type"] === "MetaProperty" &&
            identifier(object["meta"]) === "import" &&
            identifier(object["property"]) === "meta";
          if (
            nodes(initial["arguments"]).length !== 1 ||
            !(
              identifier(argument) === "__filename" ||
              (argument?.["type"] === "MemberExpression" &&
                argument["computed"] === false &&
                importMeta &&
                identifier(argument["property"]) === "url")
            )
          )
            throw new Error(
              "Packed createRequire needs import.meta.url or __filename for static resolution",
            );
          local.set(name, "require");
        }
      }
      for (const child of children(node)) walk(child, nested);
      return;
    }
    if (
      kind === "ImportDeclaration" ||
      kind === "ExportNamedDeclaration" ||
      kind === "ExportAllDeclaration"
    ) {
      const specifier = literal(node["source"]);
      if (specifier !== undefined) result.push({ specifier, mode: "import" });
    }
    if (kind === "ImportExpression") {
      const specifier = literal(node["source"]);
      if (specifier !== undefined) result.push({ specifier, mode: "import" });
    }
    if (kind === "CallExpression") {
      const callee = node["callee"];
      const name = identifier(callee);
      const resolved =
        record(callee) &&
        callee["type"] === "MemberExpression" &&
        (callee["computed"] === true
          ? literal(callee["property"])
          : identifier(callee["property"])) === "resolve"
          ? identifier(callee["object"])
          : name;
      const specifier = literal(nodes(node["arguments"]).at(0));
      if (
        resolved !== undefined &&
        binding(scopes, resolved) === "require" &&
        specifier !== undefined
      )
        result.push({ specifier, mode: "require" });
      if (
        record(callee) &&
        callee["type"] === "MemberExpression" &&
        (callee["computed"] === true
          ? literal(callee["property"])
          : identifier(callee["property"])) === "require"
      ) {
        const object = identifier(callee["object"]);
        if (
          object !== undefined &&
          binding(scopes, object) === "module" &&
          specifier !== undefined
        )
          result.push({ specifier, mode: "require" });
      }
    }
    for (const child of children(node)) walk(child, scopes);
  };
  const root = nodes(tree).at(0);
  if (root !== undefined)
    walk(root, [
      new Map([
        ["require", "require"],
        ["module", "module"],
      ]),
    ]);
  return result;
};

/** Validate the static local runtime closure against regular packed members. */
export const assertPackedRuntimeImports = async ({
  members,
  readSource,
  assertRegular,
}: PackedRuntimeImportsOptions) => {
  const files = new Map<string, string>();
  const read = async (file: string) => {
    if (!members.has(file))
      throw new Error(`Missing packed runtime file: ${file}`);
    await assertRegular(file);
    const cached = files.get(file);
    if (cached !== undefined) return cached;
    const source = await readSource(file);
    files.set(file, source);
    return source;
  };
  const manifest = async (file: string) => {
    const value: unknown = JSON.parse(await read(file));
    if (!record(value)) throw new Error(`Invalid packed manifest: ${file}`);
    return value;
  };
  for (const file of members)
    if (path.posix.basename(file) === "package.json") await manifest(file);
  const root = await manifest("package/package.json");
  const pending = [...members].filter((file) => javascript.test(file));
  const scripts = new Set(pending);
  const bin = root["bin"];
  const bins =
    bin === undefined
      ? []
      : typeof bin === "string"
        ? [bin]
        : record(bin)
          ? Object.values(bin)
          : undefined;
  if (bins === undefined) throw new Error("Invalid packed bin declaration");
  for (const entry of bins) {
    if (
      typeof entry !== "string" ||
      entry === "" ||
      path.posix.isAbsolute(entry) ||
      entry.includes("\\")
    )
      throw new Error("Invalid packed bin entry");
    const file = packagePath(path.posix.join("package", entry));
    scripts.add(file);
    pending.push(file);
  }
  const addEntry = (entry: string, mode: "file" | "url") => {
    if (declaration.test(entry)) return;
    if (path.posix.isAbsolute(entry) || entry.includes("\\"))
      throw new Error(`Runtime entry escapes the packed package: ${entry}`);
    if (mode === "url" && /%2f|%5c/iu.test(entry))
      throw new Error(`Invalid packed entry URL: ${entry}`);
    const file = packagePath(
      mode === "url"
        ? fileURLToPath(new URL(entry, "file:///package/package.json")).slice(1)
        : path.posix.join("package", entry),
    );
    if (!file.includes("*")) {
      if (javascript.test(file) || path.posix.extname(file) === "")
        scripts.add(file);
      pending.push(file);
      return;
    }
    const [prefix, suffix] = file.split("*");
    if (
      prefix === undefined ||
      suffix === undefined ||
      file.split("*").length !== 2
    )
      throw new Error(`Unsupported packed entry pattern: ${entry}`);
    const matches = [...members].filter(
      (candidate) => candidate.startsWith(prefix) && candidate.endsWith(suffix),
    );
    if (matches.length === 0)
      throw new Error(`Missing packed runtime entry pattern: ${entry}`);
    for (const match of matches)
      if (javascript.test(match) || path.posix.extname(match) === "")
        scripts.add(match);
    pending.push(...matches);
  };
  for (const target of targets(root["module"])) addEntry(target, "file");
  for (const target of targets(root["exports"])) addEntry(target, "url");
  const resolveCommonJS = async (
    file: string,
    seen = new Set<string>(),
  ): Promise<string | undefined> => {
    if (seen.has(file)) return undefined;
    seen.add(file);
    for (const candidate of [
      file,
      `${file}.js`,
      `${file}.json`,
      `${file}.node`,
    ])
      if (members.has(candidate)) return candidate;
    const packageJson = `${file}/package.json`;
    if (members.has(packageJson)) {
      const entry = (await manifest(packageJson))["main"];
      if (entry !== undefined && typeof entry !== "string")
        throw new Error(`Invalid packed main: ${packageJson}`);
      if (typeof entry === "string" && entry !== "") {
        if (path.posix.isAbsolute(entry) || entry.includes("\\"))
          throw new Error(`Invalid packed main: ${packageJson}`);
        const found = await resolveCommonJS(
          packagePath(path.posix.join(file, entry)),
          seen,
        );
        if (found !== undefined) return found;
      }
    }
    return ["js", "json", "node"]
      .map((extension) => `${file}/index.${extension}`)
      .find((candidate) => members.has(candidate));
  };
  if (root["main"] !== undefined) {
    const entry = root["main"];
    if (
      typeof entry !== "string" ||
      path.posix.isAbsolute(entry) ||
      entry.includes("\\")
    )
      throw new Error("Invalid packed main entry");
    if (!declaration.test(entry)) {
      const resolved = await resolveCommonJS(
        packagePath(path.posix.join("package", entry)),
      );
      if (resolved === undefined)
        throw new Error(`Missing packed runtime main: ${entry}`);
      if (!opaque.test(resolved)) scripts.add(resolved);
      pending.push(resolved);
    }
  }
  const mapping = (value: unknown, key: string) => {
    if (!record(value)) return undefined;
    const exact = value[key];
    if (exact !== undefined) return { key, targets: targets(exact) };
    const match = Object.keys(value)
      .filter((entry) => entry.includes("*"))
      .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length)
      .find((entry) => {
        const [prefix, suffix] = entry.split("*");
        return (
          prefix !== undefined &&
          suffix !== undefined &&
          key.startsWith(prefix) &&
          key.endsWith(suffix)
        );
      });
    if (match === undefined) return undefined;
    const [prefix, suffix] = match.split("*");
    if (prefix === undefined || suffix === undefined)
      throw new Error("Invalid packed import mapping");
    return {
      key: match,
      targets: targets(value[match]).map((entry) =>
        entry.replaceAll(
          "*",
          key.slice(prefix.length, key.length - suffix.length),
        ),
      ),
    };
  };
  type StaticResolution = StaticImport & {
    importer: string;
    mappings: ReadonlySet<string>;
  };
  const resolveImport = async ({
    specifier,
    mode,
    importer,
    mappings,
  }: StaticResolution): Promise<string[]> => {
    if (specifier.startsWith("#")) {
      let directory = path.posix.dirname(importer);
      while (
        directory !== "package" &&
        !members.has(`${directory}/package.json`)
      )
        directory = path.posix.dirname(directory);
      const owner = `${directory}/package.json`;
      const selected = mapping((await manifest(owner))["imports"], specifier);
      if (selected === undefined || selected.targets.length === 0)
        throw new Error(
          `Unresolved packed import mapping: ${importer} -> ${specifier}`,
        );
      const key = `${owner}:${selected.key}`;
      if (mappings.has(key))
        throw new Error(
          `Cyclic packed import mapping: ${importer} -> ${specifier}`,
        );
      const nextMappings = new Set(mappings);
      nextMappings.add(key);
      return (
        await Promise.all(
          selected.targets.map((target) =>
            resolveImport({
              specifier: target,
              // Package mappings use exact URL resolution, including require().
              mode: "import",
              importer: owner,
              mappings: nextMappings,
            }),
          ),
        )
      ).flat();
    }
    if (
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("file:")
    )
      return [];
    let file: string;
    if (mode === "import") {
      if (!specifier.startsWith(".") || /%2f|%5c/iu.test(specifier))
        throw new Error(
          `Runtime import escapes the packed package: ${specifier}`,
        );
      file = packagePath(
        fileURLToPath(new URL(specifier, `file:///${importer}`)).slice(1),
      );
    } else {
      if (!specifier.startsWith("."))
        throw new Error(
          `Runtime import escapes the packed package: ${specifier}`,
        );
      file = packagePath(
        path.posix.join(path.posix.dirname(importer), specifier),
      );
    }
    const resolved =
      mode === "require"
        ? await resolveCommonJS(file)
        : members.has(file)
          ? file
          : undefined;
    if (resolved === undefined)
      throw new Error(
        `Missing packed runtime import: ${importer} -> ${specifier}`,
      );
    return [resolved];
  };
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    if (!members.has(file))
      throw new Error(`Missing packed runtime file: ${file}`);
    await assertRegular(file);
    if (!scripts.has(file)) continue;
    const source = await read(file);
    const mode = /\.mjs$/iu.test(file)
      ? "module"
      : /\.cjs$/iu.test(file)
        ? "script"
        : packageMode(files, file);
    const parse = (sourceType: "script" | "module") => {
      const tree = parseArtifactSource(source, {
        ecmaVersion: "latest",
        sourceType,
        allowHashBang: true,
        allowReturnOutsideFunction: sourceType === "script",
      });
      // The shared parser wraps CommonJS. Its require parameter is the runtime loader.
      if (sourceType === "script") {
        const statement = tree.body.at(0);
        if (
          statement?.type === "ExpressionStatement" &&
          statement.expression.type === "FunctionExpression"
        )
          return { tree: statement.expression.body, mode: sourceType };
      }
      return { tree, mode: sourceType };
    };
    let parsed: ReturnType<typeof parse>;
    if (mode === "detect") {
      try {
        parsed = parse("script");
      } catch {
        parsed = parse("module");
      }
    } else parsed = parse(mode);
    for (const dependency of staticImports(parsed.tree, parsed.mode)) {
      const resolved = await resolveImport({
        ...dependency,
        importer: file,
        mappings: new Set(),
      });
      for (const target of resolved) {
        if (
          javascript.test(target) ||
          path.posix.extname(target) === "" ||
          (dependency.mode === "require" && !opaque.test(target))
        )
          scripts.add(target);
        pending.push(target);
      }
    }
  }
};
