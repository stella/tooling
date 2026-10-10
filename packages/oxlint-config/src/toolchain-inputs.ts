/** GitHub action metadata may live at the repository root or in any directory. */
export const githubAutomationFileKind = (file: string) => {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) return "workflow";
  if (/(?:^|\/)action\.ya?ml$/.test(file)) return "action";
  return undefined;
};

/** Lockfiles establish ecosystem presence without reading their dependency graphs. */
export const toolchainInputKind = (file: string) => {
  if (/(?:^|\/)(?:bun\.lock|uv\.lock)$/.test(file)) return "presence";
  if (
    githubAutomationFileKind(file) !== undefined ||
    /(?:^|\/)(?:package\.json|stll-toolchain\.json|\.bun-version|\.node-version|\.nvmrc|\.python-version|rust-toolchain(?:\.toml)?|\.tool-versions|\.?mise\.toml|pyproject\.toml|uv\.toml|\.uv\.toml|\.github\/dependabot\.ya?ml|Dockerfile[^/]*|Containerfile|Cargo\.toml|requirements[^/]*\.txt)$/.test(
      file,
    )
  )
    return "config";
  return undefined;
};
