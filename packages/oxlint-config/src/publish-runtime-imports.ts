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
type Binding =
  | "other"
  | "require"
  | "factory"
  | "module"
  | "module-api"
  | "filename";
type Scope = Map<string, Binding>;
const bindingScope = (scopes: readonly Scope[], name: string) =>
  scopes.findLast((scope) => scope.has(name));
const binding = (scopes: readonly Scope[], name: string) =>
  bindingScope(scopes, name)?.get(name);
const memberName = (value: Record<string, unknown>) =>
  value["computed"] === true
    ? literal(value["property"])
    : identifier(value["property"]);
const loaderBinding = (
  value: unknown,
  scopes: readonly Scope[],
): Binding | undefined => {
  const name = identifier(value);
  if (name !== undefined) {
    const resolved = binding(scopes, name);
    return resolved === "filename" ? "other" : resolved;
  }
  if (!record(value) || value["type"] !== "MemberExpression") return undefined;
  const owner = identifier(value["object"]);
  if (owner === undefined) return undefined;
  const kind = binding(scopes, owner);
  const property = memberName(value);
  if (kind === "module-api" && property === "createRequire") return "factory";
  if (kind === "module" && property === "require") return "require";
  if (kind === "require" && property === "resolve") return "require";
  return undefined;
};
const scopeDeclarations = (
  node: Record<string, unknown>,
): Record<string, unknown>[] => {
  if (
    (node["type"] === "ExportNamedDeclaration" ||
      node["type"] === "ExportDefaultDeclaration") &&
    record(node["declaration"])
  )
    return scopeDeclarations(node["declaration"]);
  return [node];
};
const functionNode = (node: Record<string, unknown>) =>
  [
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
  ].includes(String(node["type"]));

type StaticImport = { specifier: string; mode: "import" | "require" };
/** Read syntax only; known loaders must have statically resolvable bindings. */
const staticImports = (
  tree: unknown,
  mode: "script" | "module",
): StaticImport[] => {
  const result: StaticImport[] = [];
  const resolvedFactories = new Set<Record<string, unknown>>();
  const resolvedNamespaces = new Set<Record<string, unknown>>();
  const allowedLoaderReferences = new Set<Record<string, unknown>>();
  const allowReference = (value: unknown) => {
    for (const node of nodes(value)) {
      allowedLoaderReferences.add(node);
      for (const child of children(node)) allowReference(child);
    }
  };
  const allowPattern = (value: unknown) => {
    if (!record(value)) return;
    if (value["type"] === "Identifier") allowedLoaderReferences.add(value);
    else if (value["type"] === "Property") allowPattern(value["value"]);
    else if (value["type"] === "AssignmentPattern") allowPattern(value["left"]);
    else if (value["type"] === "RestElement") allowPattern(value["argument"]);
    else if (["ObjectPattern", "ArrayPattern"].includes(String(value["type"])))
      for (const child of children(value)) allowPattern(child);
  };
  const unresolvable = (description: string) =>
    new Error(`Unresolvable dynamic loader: ${description}`);
  const loaderName = (name: string, scopes: readonly Scope[]) => {
    const previous = binding(scopes, name);
    return (
      (mode === "script" &&
        ["require", "module", "createRequire"].includes(name)) ||
      (previous !== undefined &&
        previous !== "other" &&
        previous !== "filename")
    );
  };
  const loaderValue = (value: unknown, scopes: readonly Scope[]): boolean => {
    if (!record(value)) return false;
    const kind = loaderBinding(value, scopes);
    if (kind !== undefined && kind !== "other") return true;
    if (
      functionNode(value) ||
      [
        "CallExpression",
        "MemberExpression",
        "UnaryExpression",
        "BinaryExpression",
        "TemplateLiteral",
      ].includes(String(value["type"]))
    )
      return false;
    if (value["type"] === "Property")
      return loaderValue(value["value"], scopes);
    return children(value).some((child) => loaderValue(child, scopes));
  };
  const walk = (
    node: Record<string, unknown>,
    scopes: readonly Scope[],
    parent?: Record<string, unknown>,
  ) => {
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
        allowPattern(pattern);
        for (const name of patternNames(pattern)) {
          if (loaderName(name, scopes))
            throw unresolvable(`unsupported loader binding: ${name}`);
          local.set(name, "other");
        }
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
        allowPattern(entry["id"]);
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
      if (
        kind === "ArrowFunctionExpression" &&
        record(node["body"]) &&
        node["body"]["type"] !== "BlockStatement" &&
        loaderValue(node["body"], [...scopes, local])
      )
        throw unresolvable("loader returned through an unsupported function");
      const statements =
        kind === "Program" || kind === "BlockStatement"
          ? nodes(node["body"]).flatMap(scopeDeclarations)
          : children(node).flatMap(scopeDeclarations);
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
          allowReference(statement["specifiers"]);
          const moduleImport = ["node:module", "module"].includes(
            literal(statement["source"]) ?? "",
          );
          const specifiers = nodes(statement["specifiers"]);
          if (moduleImport && specifiers.length === 0)
            throw unresolvable(
              "module import needs recognized static bindings",
            );
          for (const specifier of specifiers) {
            const name = identifier(specifier["local"]);
            if (name === undefined)
              throw unresolvable(
                "import binding cannot be resolved statically",
              );
            if (!moduleImport) {
              local.set(name, "other");
              continue;
            }
            const imported =
              identifier(specifier["imported"]) ??
              literal(specifier["imported"]);
            if (imported === "createRequire") local.set(name, "factory");
            else if (
              ["ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(
                String(specifier["type"]),
              ) ||
              imported === "Module" ||
              imported === "default"
            )
              local.set(name, "module-api");
            else throw unresolvable("unsupported node:module import binding");
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
      let changed = true;
      while (changed) {
        changed = false;
        const assign = (name: string, value: Binding) => {
          const owner = bindingScope(nested, name);
          if (owner === undefined)
            throw unresolvable("loader declaration has no owning scope");
          if (owner.get(name) === value) return;
          if (owner.get(name) !== "other")
            throw unresolvable("conflicting loader binding declarations");
          owner.set(name, value);
          changed = true;
        };
        for (const entry of declarations) {
          const name = identifier(entry["id"]);
          const initial = entry["init"];
          if (!record(initial)) continue;
          const alias = loaderBinding(initial, nested);
          const nodeModule =
            initial["type"] === "CallExpression" &&
            loaderBinding(initial["callee"], nested) === "require" &&
            ["node:module", "module"].includes(
              literal(nodes(initial["arguments"]).at(0)) ?? "",
            );
          if (
            (nodeModule || alias === "module-api") &&
            record(entry["id"]) &&
            entry["id"]["type"] === "ObjectPattern"
          ) {
            for (const property of nodes(entry["id"]["properties"])) {
              const key =
                property["computed"] === true
                  ? literal(property["key"])
                  : (identifier(property["key"]) ?? literal(property["key"]));
              if (property["type"] === "RestElement" || key === undefined)
                throw unresolvable(
                  "module loader destructuring cannot be resolved statically",
                );
              const factoryName = identifier(property["value"]);
              if (
                key === "createRequire" ||
                key === "Module" ||
                key === "default"
              ) {
                if (factoryName === undefined)
                  throw unresolvable(
                    "module loader binding pattern cannot be resolved statically",
                  );
                assign(
                  factoryName,
                  key === "createRequire" ? "factory" : "module-api",
                );
              } else
                throw unresolvable(
                  "unsupported module namespace destructuring",
                );
            }
          } else if (
            name === undefined &&
            alias !== undefined &&
            alias !== "other"
          ) {
            throw unresolvable(
              "loader destructuring cannot be resolved statically",
            );
          }
          if (nodeModule) resolvedNamespaces.add(initial);
          if (alias !== undefined && alias !== "other") allowReference(initial);
          if (name === undefined) continue;
          if (alias !== undefined && alias !== "other") assign(name, alias);
          if (nodeModule) assign(name, "module-api");
          if (
            initial["type"] === "CallExpression" &&
            loaderBinding(initial["callee"], nested) === "factory"
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
                (identifier(argument) === "__filename" &&
                  binding(nested, "__filename") === "filename") ||
                (argument?.["type"] === "MemberExpression" &&
                  argument["computed"] === false &&
                  importMeta &&
                  identifier(argument["property"]) === "url")
              )
            )
              throw unresolvable(
                "createRequire needs import.meta.url or __filename",
              );
            assign(name, "require");
            resolvedFactories.add(initial);
          }
        }
      }
      for (const entry of declarations) {
        const initial = entry["init"];
        for (const name of patternNames(entry["id"])) {
          if (loaderName(name, scopes) && binding(nested, name) === "other")
            throw unresolvable(`unknown loader declaration: ${name}`);
          const resolved = binding(nested, name);
          const source = loaderBinding(initial, nested);
          if (
            initial !== null &&
            resolved !== undefined &&
            resolved !== "other" &&
            (source === undefined || source === "other") &&
            (!record(initial) ||
              (!resolvedFactories.has(initial) &&
                !resolvedNamespaces.has(initial)))
          )
            throw unresolvable(`unknown loader initializer: ${name}`);
        }
        if (
          loaderBinding(initial, nested) === undefined &&
          loaderValue(initial, nested)
        )
          throw unresolvable(
            "binding initializer cannot be resolved statically",
          );
      }
      for (const child of children(node)) walk(child, nested, node);
      return;
    }
    if (
      kind === "ImportDeclaration" ||
      kind === "ExportNamedDeclaration" ||
      kind === "ExportAllDeclaration"
    ) {
      const specifier = literal(node["source"]);
      if (
        kind !== "ImportDeclaration" &&
        ["node:module", "module"].includes(specifier ?? "")
      )
        throw unresolvable(
          "module re-export is not a recognized static binding",
        );
      if (specifier !== undefined) result.push({ specifier, mode: "import" });
      if (kind === "ExportNamedDeclaration") allowReference(node["specifiers"]);
    }
    if (kind === "ImportExpression") {
      const specifier = literal(node["source"]);
      if (specifier === undefined)
        throw unresolvable("dynamic import needs a literal module specifier");
      if (["node:module", "module"].includes(specifier))
        throw unresolvable("dynamic module namespace imports are unsupported");
      result.push({ specifier, mode: "import" });
    }
    if (kind === "CallExpression") {
      const callee = node["callee"];
      const resolved = loaderBinding(callee, scopes);
      const specifier = literal(nodes(node["arguments"]).at(0));
      if (resolved === "require") {
        if (specifier === undefined || nodes(node["arguments"]).length !== 1)
          throw unresolvable(
            "require/resolve needs one literal module specifier",
          );
        allowReference(callee);
        if (
          ["node:module", "module"].includes(specifier) &&
          !resolvedNamespaces.has(node)
        )
          throw unresolvable(
            "module namespace needs a resolvable local binding",
          );
        result.push({ specifier, mode: "require" });
      }
      if (resolved === "factory") {
        if (!resolvedFactories.has(node))
          throw unresolvable(
            "createRequire result needs a resolvable local binding",
          );
        allowReference(callee);
      }
      if (
        record(callee) &&
        callee["type"] === "MemberExpression" &&
        ["require", "factory"].includes(
          loaderBinding(callee["object"], scopes) ?? "",
        ) &&
        resolved === undefined
      )
        throw unresolvable("loader method cannot be resolved statically");
      if (
        resolved !== "require" &&
        resolved !== "factory" &&
        nodes(node["arguments"]).some((argument) =>
          loaderValue(argument, scopes),
        )
      )
        throw unresolvable("loader passed through an unsupported call");
    }
    if (kind === "AssignmentExpression") {
      const assigned = loaderBinding(node["right"], scopes);
      if (
        loaderValue(node["right"], scopes) &&
        (node["operator"] !== "=" ||
          loaderBinding(node["left"], scopes) !== assigned ||
          assigned === undefined)
      )
        throw unresolvable("loader assignment cannot be resolved statically");
      for (const name of patternNames(node["left"])) {
        const previous = binding(scopes, name);
        if (
          loaderName(name, scopes) &&
          (previous === undefined || previous === "other")
        )
          throw unresolvable(`unknown loader assignment: ${name}`);
        if (
          previous !== undefined &&
          previous !== "other" &&
          (node["operator"] !== "=" ||
            loaderBinding(node["right"], scopes) !== previous)
        )
          throw unresolvable(
            "loader reassignment cannot be resolved statically",
          );
      }
    }
    if (kind === "ReturnStatement" && loaderValue(node["argument"], scopes))
      throw unresolvable("loader returned through an unsupported function");
    // Only the recognized static forms grant permission to reference a loader.
    const nonReference =
      parent !== undefined &&
      ((parent["type"] === "MemberExpression" &&
        parent["computed"] === false &&
        parent["property"] === node) ||
        (["Property", "MethodDefinition", "PropertyDefinition"].includes(
          String(parent["type"]),
        ) &&
          parent["computed"] === false &&
          parent["key"] === node &&
          parent["value"] !== node));
    const reference = loaderBinding(node, scopes);
    const name = identifier(node);
    if (
      name !== undefined &&
      loaderName(name, scopes) &&
      (reference === undefined || reference === "other") &&
      !nonReference &&
      !allowedLoaderReferences.has(node)
    )
      throw unresolvable(`unknown loader reference: ${name}`);
    const moduleExports =
      reference === "module" &&
      parent?.["type"] === "MemberExpression" &&
      parent["object"] === node &&
      memberName(parent) === "exports";
    if (
      reference !== undefined &&
      reference !== "other" &&
      !moduleExports &&
      !nonReference &&
      !allowedLoaderReferences.has(node)
    )
      throw unresolvable("loader reference is not a recognized static form");
    for (const child of children(node)) walk(child, scopes, node);
  };
  const root = nodes(tree).at(0);
  if (root !== undefined)
    walk(root, [
      mode === "script"
        ? new Map<string, Binding>([
            ["require", "require"],
            ["module", "module"],
            ["__filename", "filename"],
          ])
        : new Map<string, Binding>(),
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
  const validated = new Set<string>();
  const traversed = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined) continue;
    if (!validated.has(file)) {
      if (!members.has(file))
        throw new Error(`Missing packed runtime file: ${file}`);
      await assertRegular(file);
      validated.add(file);
    }
    if (!scripts.has(file) || traversed.has(file)) continue;
    traversed.add(file);
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
    let dependencies: StaticImport[];
    try {
      dependencies = staticImports(parsed.tree, parsed.mode);
    } catch (error) {
      throw new Error(`Packed runtime imports ${file}: ${String(error)}`, {
        cause: error,
      });
    }
    for (const dependency of dependencies) {
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
