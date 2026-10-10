import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export type ToolchainDiagnostic = {
  path: string;
  line: number;
  message: string;
};

export type CheckToolchainOptions = {
  root: string;
  bunVersion: string;
  allowNonBunPackageManagers?: readonly string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const scalar = (value: string) =>
  value
    .trim()
    .replace(/\s+#.*$/, "")
    .replace(/^["']|["']$/g, "");

const trackedPath = (file: string) =>
  !file.split("/").some((part) => part === "node_modules" || part === "vendor");

/** Check tracked consumer files without traversing dependencies or the working tree. */
export const checkToolchain = ({
  root,
  bunVersion,
  allowNonBunPackageManagers = [],
}: CheckToolchainOptions): ToolchainDiagnostic[] => {
  const files = execFileSync("git", ["ls-files", "-z", "--cached"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file !== "" && trackedPath(file));
  const tracked = new Set(files);
  const diagnostics: ToolchainDiagnostic[] = [];
  const add = (file: string, line: number, message: string) => {
    diagnostics.push({ path: file, line, message });
  };
  const read = (file: string): string | undefined => {
    try {
      return readFileSync(path.join(root, file), "utf8");
    } catch {
      add(file, 1, "cannot read tracked file");
      return undefined;
    }
  };
  const checkVersion = (
    file: string,
    line: number,
    value: unknown,
    label: string,
  ) => {
    if (value !== bunVersion) {
      add(file, line, `${label} must be ${bunVersion}, found ${String(value)}`);
    }
  };
  const packages = new Map<
    string,
    { manager: unknown; json: Record<string, unknown>; text: string }
  >();
  for (const file of files.filter(
    (entry) => path.basename(entry) === "package.json",
  )) {
    const text = read(file);
    if (text === undefined) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      add(file, 1, "invalid package.json");
      continue;
    }
    if (!isRecord(json)) {
      add(file, 1, "package.json must contain an object");
      continue;
    }
    packages.set(file, { manager: json["packageManager"], json, text });
  }
  const catalogSource = (json: Record<string, unknown>) =>
    isRecord(json["workspaces"]) ? json["workspaces"] : json;
  const rootCatalogs = catalogSource(packages.get("package.json")?.json ?? {});
  for (const [file, { json, text }] of packages) {
    const lines = text.split(/\r?\n/);
    const reportedLines = new Map<string, number>();
    const propertyLine = (key: string, value?: unknown) => {
      const serialized = JSON.stringify(value);
      const matchKey = `${key}:${serialized ?? ""}`;
      const previous = reportedLines.get(matchKey) ?? -1;
      const index = lines.findIndex(
        (line, lineIndex) =>
          lineIndex > previous &&
          line.includes(`"${key}"`) &&
          (serialized === undefined || line.includes(serialized)),
      );
      if (index >= 0) reportedLines.set(matchKey, index);
      return Math.max(1, index + 1);
    };
    if (json["packageManager"] !== undefined) {
      if (
        typeof json["packageManager"] === "string" &&
        json["packageManager"].startsWith("bun@")
      ) {
        checkVersion(
          file,
          propertyLine("packageManager"),
          json["packageManager"].slice(4),
          "packageManager Bun version",
        );
      } else if (!allowNonBunPackageManagers.includes(file)) {
        add(
          file,
          propertyLine("packageManager"),
          "packageManager is not Bun; use --allow-non-bun-package-manager with this path to allow it",
        );
      }
    }
    const checkDependencies = (value: unknown, resolveCatalog = false) => {
      if (!isRecord(value) || value["bun-types"] === undefined) return;
      const specifier = value["bun-types"];
      const resolveVersion = () => {
        if (
          !resolveCatalog ||
          typeof specifier !== "string" ||
          !specifier.startsWith("catalog:")
        )
          return specifier;
        const catalogName = specifier.slice("catalog:".length);
        const source =
          file === "package.json" ? catalogSource(json) : rootCatalogs;
        const catalog =
          catalogName === ""
            ? source["catalog"]
            : isRecord(source["catalogs"]) && source["catalogs"][catalogName];
        return isRecord(catalog) ? catalog["bun-types"] : undefined;
      };
      checkVersion(
        file,
        propertyLine("bun-types", specifier),
        resolveVersion(),
        "bun-types",
      );
    };
    checkDependencies(json["dependencies"], true);
    checkDependencies(json["devDependencies"], true);
    checkDependencies(json["catalog"]);
    if (isRecord(json["catalogs"])) {
      for (const catalog of Object.values(json["catalogs"]))
        checkDependencies(catalog);
    }
    if (isRecord(json["workspaces"])) {
      checkDependencies(json["workspaces"]["catalog"]);
      if (isRecord(json["workspaces"]["catalogs"])) {
        for (const catalog of Object.values(json["workspaces"]["catalogs"]))
          checkDependencies(catalog);
      }
    }
  }
  for (const file of files) {
    const name = path.basename(file);
    const workflow =
      /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) ||
      /^\.github\/actions\/.+\/action\.ya?ml$/.test(file);
    const dockerfile = /^Dockerfile/.test(name) || name === "Containerfile";
    const versionFile = name === ".bun-version" || name === ".tool-versions";
    const mise = name === "mise.toml" || name === ".mise.toml";
    if (!workflow && !dockerfile && !versionFile && !mise) continue;
    const text = read(file);
    if (text === undefined) continue;
    if (name === ".bun-version")
      checkVersion(file, 1, scalar(text), ".bun-version");
    let section = "";
    for (const [index, original] of text.split(/\r?\n/).entries()) {
      const line = index + 1;
      if (/^\s*#/.test(original) || original.trim() === "") continue;
      if (workflow) {
        const pin = original.match(
          /(?:^\s*(?:-\s*)?|[{,]\s*)["']?bun-version["']?\s*:/,
        );
        if (pin !== null)
          add(
            file,
            line,
            "bun-version literals are forbidden; use bun-version-file pointing to a package.json with the shared Bun pin",
          );
        const reference = original.match(
          /(?:^\s*(?:-\s*)?|[{,]\s*)["']?bun-version-file["']?\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,}]*))/,
        );
        if (reference !== null) {
          const target = scalar(
            reference[1] ?? reference[2] ?? reference[3] ?? "",
          );
          const normalized = path.posix.normalize(target);
          const pkg = packages.get(normalized);
          if (
            target === "" ||
            path.posix.isAbsolute(target) ||
            normalized.startsWith("../") ||
            !tracked.has(normalized) ||
            path.basename(normalized) !== "package.json" ||
            pkg?.manager !== `bun@${bunVersion}`
          ) {
            add(
              file,
              line,
              `bun-version-file must reference a tracked package.json with packageManager bun@${bunVersion}, found ${target}`,
            );
          }
        }
      }
      if (dockerfile) {
        const image = original.match(
          /^\s*FROM\s+(?:--\S+\s+)*oven\/bun(?::([^\s@]+))?(?:@\S+)?(?:\s|$)/i,
        );
        if (image !== null) {
          const tag = image[1];
          if (tag !== undefined) {
            const version = tag.match(/^(\d+\.\d+\.\d+)(?:-|$)/)?.[1];
            checkVersion(file, line, version ?? tag, "oven/bun version");
          } else if (!/oven\/bun@/i.test(original)) {
            add(file, line, `oven/bun must use a ${bunVersion} version tag`);
          }
        }
      }
      if (name === ".tool-versions") {
        const entry = original.match(/^\s*bun\s+(.+)$/);
        if (entry !== null)
          checkVersion(
            file,
            line,
            scalar(entry[1] ?? ""),
            ".tool-versions Bun version",
          );
      }
      if (mise) {
        const heading = original.match(/^\s*\[([^\]]+)\]/);
        if (heading !== null) section = heading[1] ?? "";
        const checkMiseVersion = (value: string) => {
          const inlineVersion = value.match(
            /^\s*\{\s*version\s*=\s*(["'][^"']+["'])\s*(?:,|\})/,
          );
          checkVersion(
            file,
            line,
            scalar(inlineVersion?.[1] ?? value),
            "mise Bun version",
          );
        };
        const entry = original.match(/^\s*["']?bun["']?\s*=\s*(.+)$/);
        if (entry !== null && section === "tools")
          checkMiseVersion(entry[1] ?? "");
        const dotted = original.match(
          /^\s*tools\.bun(?:\.version)?\s*=\s*(.+)$/,
        );
        if (dotted !== null && section === "")
          checkMiseVersion(dotted[1] ?? "");
        const tableVersion = original.match(/^\s*version\s*=\s*(.+)$/);
        if (tableVersion !== null && section === "tools.bun")
          checkMiseVersion(tableVersion[1] ?? "");
        const inlineTools = original.match(/^\s*tools\s*=\s*\{(.*)\}/);
        if (inlineTools !== null && section === "") {
          const inlineBun = inlineTools[1]?.match(
            /(?:^|,)\s*["']?bun["']?\s*=\s*([^,}]+)/,
          );
          if (inlineBun !== null && inlineBun !== undefined)
            checkMiseVersion(inlineBun[1] ?? "");
        }
      }
    }
  }
  return diagnostics;
};
