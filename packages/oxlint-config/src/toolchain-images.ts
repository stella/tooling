/** Docker Hub spellings accepted by the shared runtime policy. */
export const dockerHubRegistries = [
  "docker.io",
  "index.docker.io",
  "registry-1.docker.io",
] as const;

/** Expand the full accepted repository alias class without parsing Dockerfile instructions. */
export const ownedDockerImageAliases = (images: readonly string[]) => {
  const aliases = new Set<string>();
  for (const image of images) {
    for (const repository of [image, `library/${image}`]) {
      aliases.add(repository);
      for (const registry of dockerHubRegistries)
        aliases.add(`${registry}/${repository}`);
    }
  }
  return [...aliases].sort();
};

/** Preserve tag/digest spelling while normalizing registry and namespace aliases. */
export const canonicalDockerRuntime = (image: string) => {
  const registry = dockerHubRegistries.find((entry) =>
    image.toLowerCase().startsWith(`${entry}/`),
  );
  const repository =
    registry === undefined ? image : image.slice(registry.length + 1);
  return repository.replace(/^library\//i, "");
};
