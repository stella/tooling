const excludedInputPath = (file: string) =>
  file === "" ||
  file.split("/").some((part) => part === "node_modules" || part === "vendor");

/** Match project, environment, local, and fragment filenames recognized by mise. */
export const isMiseConfigPath = (file: string) =>
  !excludedInputPath(file) &&
  (/(?:^|\/)\.?mise(?:\.[^./][^/]*)?\.toml$/.test(file) ||
    /(?:^|\/)(?:\.?mise|\.config\/mise)\/config(?:\.[^./][^/]*)?\.toml$/.test(
      file,
    ) ||
    /(?:^|\/)(?:\.?mise|\.config\/mise)\/conf\.d\/[^./][^/]*\.toml$/.test(
      file,
    ));

/** GitHub action metadata may live at the repository root or in any directory. */
export const githubAutomationFileKind = (file: string) => {
  if (excludedInputPath(file)) return undefined;
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) return "workflow";
  if (/(?:^|\/)action\.ya?ml$/.test(file)) return "action";
  return undefined;
};

/** Lockfiles establish ecosystem presence without reading their dependency graphs. */
export const toolchainInputKind = (file: string) => {
  if (excludedInputPath(file)) return undefined;
  if (/(?:^|\/)(?:bun\.lock|uv\.lock)$/.test(file)) return "presence";
  if (
    githubAutomationFileKind(file) !== undefined ||
    isMiseConfigPath(file) ||
    /(?:^|\/)(?:package\.json|stll-toolchain\.json|\.bun-version|\.node-version|\.nvmrc|\.python-version|rust-toolchain(?:\.toml)?|\.tool-versions|\.?mise\.toml|pyproject\.toml|uv\.toml|\.uv\.toml|\.github\/dependabot\.ya?ml|Dockerfile[^/]*|Containerfile|Cargo\.toml|requirements[^/]*\.txt)$/.test(
      file,
    )
  )
    return "config";
  return undefined;
};
