import { cloudSetupPath } from "./cloud-setup";
import {
  isComposeDefinitionPath,
  isKubernetesDefinitionPath,
} from "./toolchain-container-inputs";

const excludedInputPath = (file: string) =>
  file === "" ||
  file.split("/").some((part) => part === "node_modules" || part === "vendor");

export const javascriptDependencyLockfiles = [
  "bun.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
] as const;

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
  if (file === "") return undefined;
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) return "workflow";
  if (/(?:^|\/)action\.ya?ml$/.test(file)) return "action";
  return undefined;
};

/** Dependabot updates workflows and repository-root action metadata. */
export const isDependabotGithubActionsPath = (file: string) => {
  const kind = githubAutomationFileKind(file);
  return kind === "workflow" || (kind === "action" && !file.includes("/"));
};

/** Use one filename discriminator for reader selection and Python ecosystem decisions. */
export const pythonDependencyManifestKind = (file: string) => {
  if (excludedInputPath(file)) return undefined;
  const name = file.split("/").at(-1);
  if (name === "pyproject.toml") return "project";
  if (name === "Pipfile") return "pipfile";
  if (name === "Pipfile.lock") return "pipfile-lock";
  if (name === "setup.py" || name === "setup.cfg") return "setup";
  if (name !== undefined && /^requirements[^/]*\.(?:txt|in)$/.test(name))
    return "requirements";
  return undefined;
};

export const isPythonDependencyManifest = (file: string) =>
  pythonDependencyManifestKind(file) !== undefined;

/** Docker definition names use dot-delimited variants, excluding source and documentation. */
export const isDockerDefinitionPath = (file: string) => {
  if (excludedInputPath(file)) return false;
  const name = file.split("/").at(-1) ?? "";
  if (
    /\.(?:[cm]?[jt]sx?|mdx?|rst|txt|html?|py|rs|go|java|sh|c|cc|cpp|cxx|h|hpp|cs|rb|php|swift|kt|css|scss)$/i.test(
      name,
    )
  )
    return false;
  return /^(?:[^./]+\.)*(?:dockerfile|containerfile)(?:\.[^./]+)*$/i.test(name);
};

/** Lockfiles establish ecosystem presence without reading their dependency graphs. */
export const toolchainInputKind = (file: string) => {
  if (file === cloudSetupPath) return "config";
  if (githubAutomationFileKind(file) !== undefined) return "config";
  if (excludedInputPath(file)) return undefined;
  if (
    pythonDependencyManifestKind(file) === "pipfile-lock" ||
    javascriptDependencyLockfiles.some(
      (name) => file.split("/").at(-1) === name,
    ) ||
    /(?:^|\/)uv\.lock$/.test(file)
  )
    return "presence";
  if (
    githubAutomationFileKind(file) !== undefined ||
    isMiseConfigPath(file) ||
    isPythonDependencyManifest(file) ||
    isDockerDefinitionPath(file) ||
    isComposeDefinitionPath(file) ||
    isKubernetesDefinitionPath(file) ||
    /(?:^|\/)(?:package\.json|consumer-compat\.json|pnpm-workspace\.yaml|stll-toolchain\.json|\.bun-version|\.node-version|\.nvmrc|\.python-version|rust-toolchain(?:\.toml)?|\.tool-versions|\.?mise\.toml|uv\.toml|\.uv\.toml|\.github\/dependabot\.ya?ml|Cargo\.toml)$/.test(
      file,
    )
  )
    return "config";
  return undefined;
};
