import { parse } from "smol-toml";

import {
  REQUIRED_RELEASE_AGE_SECONDS,
  checkQuarantinePolicy,
  isFirstPartyPackageName,
  pruneExpiredExcludes,
  readRegistryFirstPartyPackages,
  synchronizeFirstPartyExcludes,
} from "./quarantine-policy-core";

export {
  EXACT_UTC_TIMESTAMP,
  NPM_REGISTRY,
  REQUIRED_RELEASE_AGE_SECONDS,
  exactTimestamp,
} from "./quarantine-policy-core";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Derive exact registry identities before install, including catalog references. */
export const declaredFirstPartyPackages = (files: Record<string, string>) => {
  const names = new Set<string>();
  for (const [file, text] of Object.entries(files)) {
    if (!/(?:^|\/)package\.json$/.test(file)) continue;
    const manifest: unknown = JSON.parse(text);
    if (!record(manifest)) throw new Error(`${file} must contain an object`);
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const dependencies = manifest[field];
      if (!record(dependencies)) continue;
      for (const [name, specifier] of Object.entries(dependencies)) {
        if (typeof specifier !== "string") continue;
        if (
          /^(?:workspace:|file:|link:|git(?:\+|:)|https?:|github:|\.\.?\/|\/)/.test(
            specifier,
          )
        )
          continue;
        if (specifier.startsWith("npm:")) {
          const alias = /^npm:(@[^/]+\/[^@]+|[^@]+)@/.exec(specifier)?.at(1);
          if (alias !== undefined && isFirstPartyPackageName(alias))
            names.add(alias);
          continue;
        }
        if (isFirstPartyPackageName(name)) names.add(name);
      }
    }
  }
  return names;
};

type RepositoryQuarantineOptions = {
  files: Record<string, string>;
  now?: Date | undefined;
  npmrcPresent?: boolean | undefined;
};

export const checkRepositoryQuarantine = ({
  files,
  now,
  npmrcPresent,
}: RepositoryQuarantineOptions) =>
  checkQuarantinePolicy({
    bunfig: files["bunfig.toml"] ?? "",
    lockfile: files["bun.lock"],
    firstPartyPackages: declaredFirstPartyPackages(files),
    parseToml: parse,
    ...(now === undefined ? {} : { now }),
    ...(npmrcPresent === undefined ? {} : { npmrcPresent }),
  });

export const synchronizeRepositoryQuarantine = ({
  files,
  now,
}: RepositoryQuarantineOptions) => {
  const firstPartyPackages = new Set([
    ...declaredFirstPartyPackages(files),
    ...readRegistryFirstPartyPackages(files["bun.lock"]),
  ]);
  return synchronizeFirstPartyExcludes({
    bunfig:
      files["bunfig.toml"] ??
      `[install]\nminimumReleaseAge = ${REQUIRED_RELEASE_AGE_SECONDS}\nminimumReleaseAgeExcludes = []\n`,
    firstPartyPackages,
    parseToml: parse,
    ...(now === undefined ? {} : { now }),
  });
};

export const pruneRepositoryQuarantine = ({
  files,
  now,
}: RepositoryQuarantineOptions) =>
  pruneExpiredExcludes({
    bunfig: files["bunfig.toml"] ?? "",
    parseToml: parse,
    ...(now === undefined ? {} : { now }),
  });
