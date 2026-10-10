import { consumerRecord } from "./consumer-compat-config";

// Approvals come from direct fixture declarations and the manager's resolved lock,
// never from transitive packages or a blanket script permission.
export const consumerBuildApprovals = ({
  manifest,
  lock,
  manager,
}: {
  manifest: Record<string, unknown>;
  lock: unknown;
  manager: "npm" | "pnpm";
}) => {
  if (!consumerRecord(lock))
    throw new Error("invalid consumer dependency lock");
  const approvals: Record<string, true> = {};
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    const entries = manifest[field];
    if (entries === undefined) continue;
    if (!consumerRecord(entries)) throw new Error(`invalid fixture ${field}`);
    for (const name of Object.keys(entries)) {
      if (manager === "npm") {
        const packages = lock["packages"];
        if (!consumerRecord(packages))
          throw new Error("missing npm lock packages");
        const dependency = packages[`node_modules/${name}`];
        if (!consumerRecord(dependency)) {
          if (field === "optionalDependencies") continue;
          throw new Error(`missing installed fixture dependency: ${name}`);
        }
        const resolved = dependency["resolved"];
        const version = dependency["version"];
        if (
          typeof resolved === "string" &&
          !resolved.startsWith("https://registry.npmjs.org/")
        ) {
          approvals[
            resolved.startsWith("file:") ? resolved : `file:${resolved}`
          ] = true;
        } else if (typeof version === "string") {
          approvals[`${name}@${version}`] = true;
        } else
          throw new Error(
            `missing resolved fixture dependency identity: ${name}`,
          );
      } else {
        const importers = lock["importers"];
        const importer = consumerRecord(importers) ? importers["."] : undefined;
        const dependencies = consumerRecord(importer)
          ? importer[field]
          : undefined;
        const dependency = consumerRecord(dependencies)
          ? dependencies[name]
          : undefined;
        const version = consumerRecord(dependency)
          ? dependency["version"]
          : undefined;
        if (typeof version !== "string") {
          if (field === "optionalDependencies") continue;
          throw new Error(
            `missing resolved fixture dependency identity: ${name}`,
          );
        }
        const resolvedVersion = version.replace(/\([^)]*\)/g, "");
        approvals[`${name}@${resolvedVersion}`] = true;
      }
    }
  }
  return approvals;
};
