const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Filename class recognized by Dependabot's Docker Compose fetcher. */
export const isComposeDefinitionPath = (file: string) =>
  /(docker-)?compose(-[\w]+)?(?:\.[\w-]+)?\.ya?ml/i.test(
    file.split("/").at(-1) ?? "",
  );

/** Candidate YAML files are classified by their document shape after reading. */
export const isKubernetesDefinitionPath = (file: string) =>
  /^[^.].*\.ya?ml$/i.test(file.split("/").at(-1) ?? "");

type ContainerImage = { image: unknown; path: (string | number)[] };
type ContainerDocument = {
  ecosystem: "docker-compose" | "docker";
  images: ContainerImage[];
};

export const kubernetesPodSpecPaths = {
  Pod: ["spec"],
  Deployment: ["spec", "template", "spec"],
  DaemonSet: ["spec", "template", "spec"],
  StatefulSet: ["spec", "template", "spec"],
  ReplicaSet: ["spec", "template", "spec"],
  ReplicationController: ["spec", "template", "spec"],
  Job: ["spec", "template", "spec"],
  CronJob: ["spec", "jobTemplate", "spec", "template", "spec"],
} as const;

/** Shared semantic image enumeration for runtime checks and update-root generation. */
export const containerDocumentImages = (
  document: unknown,
  file: string,
): ContainerDocument | undefined => {
  if (!record(document)) return undefined;
  const services = document["services"];
  if (isComposeDefinitionPath(file) && record(services)) {
    const images: ContainerImage[] = [];
    for (const [name, service] of Object.entries(services)) {
      if (record(service) && service["image"] !== undefined)
        images.push({
          image: service["image"],
          path: ["services", name, "image"],
        });
    }
    return { ecosystem: "docker-compose", images };
  }
  if (
    typeof document["apiVersion"] !== "string" ||
    typeof document["kind"] !== "string"
  )
    return undefined;
  const images: ContainerImage[] = [];
  const visited = new Set<Record<string, unknown>>();
  const walkResource = (
    resource: Record<string, unknown>,
    prefix: (string | number)[],
  ) => {
    if (visited.has(resource)) return;
    visited.add(resource);
    if (
      typeof resource["apiVersion"] !== "string" ||
      typeof resource["kind"] !== "string"
    )
      return;
    if (resource["kind"] === "List" && Array.isArray(resource["items"])) {
      for (const [index, item] of resource["items"].entries())
        if (record(item)) walkResource(item, [...prefix, "items", index]);
      return;
    }
    const specPath = Object.entries(kubernetesPodSpecPaths).find(
      ([kind]) => kind === resource["kind"],
    )?.[1];
    if (specPath === undefined) return;
    let spec: unknown = resource;
    for (const key of specPath) spec = record(spec) ? spec[key] : undefined;
    if (!record(spec)) return;
    for (const key of ["containers", "initContainers", "ephemeralContainers"]) {
      const containers = spec[key];
      if (!Array.isArray(containers)) continue;
      for (const [index, container] of containers.entries()) {
        if (record(container) && container["image"] !== undefined)
          images.push({
            image: container["image"],
            path: [...prefix, ...specPath, key, index, "image"],
          });
      }
    }
  };
  walkResource(document, []);
  return images.length === 0 ? undefined : { ecosystem: "docker", images };
};
