import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packageMode, parseArtifactSource } from "./publish-artifact-parser";
import { createPackedNodeResolver } from "./publish-node-resolver";

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
  const exportedLoader = (
    value: unknown,
    scopes: readonly Scope[],
  ): boolean => {
    if (!record(value) || functionNode(value)) return false;
    if (loaderValue(value, scopes)) return true;
    if (value["type"] === "CallExpression") {
      const callee = loaderBinding(value["callee"], scopes);
      return (
        callee === "factory" ||
        (callee === "require" &&
          ["node:module", "module"].includes(
            literal(nodes(value["arguments"]).at(0)) ?? "",
          ))
      );
    }
    if (value["type"] === "Property")
      return exportedLoader(value["value"], scopes);
    if (
      [
        "ObjectExpression",
        "ArrayExpression",
        "ConditionalExpression",
        "LogicalExpression",
        "SequenceExpression",
      ].includes(String(value["type"]))
    )
      return children(value).some((child) => exportedLoader(child, scopes));
    return false;
  };
  const unsupportedPropagation = () =>
    unresolvable("unsupported loader propagation across module exports");
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
      kind === "ExportDefaultDeclaration" &&
      exportedLoader(node["declaration"], scopes)
    )
      throw unsupportedPropagation();
    if (kind === "ExportNamedDeclaration") {
      const declaration = node["declaration"];
      if (record(declaration) && declaration["type"] === "VariableDeclaration")
        for (const entry of nodes(declaration["declarations"])) {
          if (
            patternNames(entry["id"]).some((name) => {
              const resolved = binding(scopes, name);
              return (
                resolved !== undefined &&
                resolved !== "other" &&
                resolved !== "filename"
              );
            }) ||
            exportedLoader(entry["init"], scopes)
          )
            throw unsupportedPropagation();
        }
      if (literal(node["source"]) === undefined)
        for (const specifier of nodes(node["specifiers"]))
          if (exportedLoader(specifier["local"], scopes))
            throw unsupportedPropagation();
      // Exported names and source re-export names are not lexical references.
      // All actual local bindings were checked before granting this permission.
      allowReference(node["specifiers"]);
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
        throw unsupportedPropagation();
      if (specifier !== undefined) result.push({ specifier, mode: "import" });
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
        exportedLoader(node["right"], scopes) &&
        (node["operator"] !== "=" ||
          loaderBinding(node["left"], scopes) !== assigned ||
          assigned === undefined)
      )
        throw unsupportedPropagation();
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
  const scratch = await realpath(
    await mkdtemp(path.join(tmpdir(), "packed-node-resolution-")),
  );
  const resolver = createPackedNodeResolver();
  try {
    // Recreate the archive's existence index without extracting paths or links.
    // Node reads manifest contents; other members are byte-free placeholders.
    // Every selected target is still validated as a regular archive member.
    for (const file of members) {
      const directory = file.endsWith("/");
      const member = directory ? file.slice(0, -1) : file;
      if (packagePath(member) !== member)
        throw new Error(`Invalid packed member path: ${file}`);
      const destination = path.join(scratch, member);
      if (directory) {
        await mkdir(destination, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(
        destination,
        path.posix.basename(file) === "package.json" ? await read(file) : "",
      );
    }
    // External dependencies are outside the archive closure. Give Node inert
    // metadata for bare #imports targets so it can select the exact runtime
    // condition without requiring a dependency install or executing packages.
    const externalFiles = new Set<string>();
    for (const file of members) {
      if (path.posix.basename(file) !== "package.json") continue;
      const owner = await manifest(file);
      for (const target of targets(owner["imports"])) {
        if (
          target.startsWith(".") ||
          target.startsWith("#") ||
          target.includes(":")
        )
          continue;
        const parts = target.split("/");
        const name = target.startsWith("@")
          ? parts.slice(0, 2).join("/")
          : parts.at(0);
        if (
          name === undefined ||
          !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/iu.test(name) ||
          name.split("/").some((part) => part === "." || part === "..")
        )
          throw new Error(`Unsupported external import mapping: ${target}`);
        if (name === owner["name"]) continue;
        const directory = path.join(scratch, "node_modules", name);
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "package.json"),
          JSON.stringify({
            name,
            exports: { ".": "./external.cjs", "./*": "./external.cjs" },
          }),
        );
        const entry = path.join(directory, "external.cjs");
        await writeFile(entry, "");
        externalFiles.add(entry);
      }
    }
    const resolveImport = async ({
      specifier,
      mode,
      importer,
    }: StaticImport & { importer: string }): Promise<string[]> => {
      let resolved: string | null;
      try {
        resolved = await resolver.resolve({
          specifier,
          mode,
          file: path.join(scratch, importer),
        });
      } catch (error) {
        throw new Error(
          `Missing packed runtime import: ${importer} -> ${specifier}: ${String(error)}`,
          { cause: error },
        );
      }
      if (resolved === null) return [];
      const url = new URL(resolved);
      if (url.protocol !== "file:")
        throw new Error(`Unsupported packed runtime URL: ${resolved}`);
      const destination = fileURLToPath(url);
      if (externalFiles.has(destination)) return [];
      const file = packagePath(
        path.relative(scratch, destination).split(path.sep).join("/"),
      );
      if (!members.has(file))
        throw new Error(
          `Missing packed runtime import: ${importer} -> ${specifier} (${file})`,
        );
      return [file];
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
          ? fileURLToPath(new URL(entry, "file:///package/package.json")).slice(
              1,
            )
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
        (candidate) =>
          candidate.startsWith(prefix) && candidate.endsWith(suffix),
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
    if (root["main"] !== undefined) {
      const entry = root["main"];
      if (
        typeof entry !== "string" ||
        path.posix.isAbsolute(entry) ||
        entry.includes("\\")
      )
        throw new Error("Invalid packed main entry");
      if (!declaration.test(entry)) {
        const resolved = (
          await resolveImport({
            specifier: "./package",
            mode: "require",
            importer: "entry.cjs",
          })
        ).at(0);
        if (resolved === undefined)
          throw new Error(`Missing packed runtime main: ${entry}`);
        if (!opaque.test(resolved)) scripts.add(resolved);
        pending.push(resolved);
      }
    }
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
  } finally {
    try {
      await resolver.close();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
};
