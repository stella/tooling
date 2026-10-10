import { consumerRelativePath } from "./consumer-compat-config";

export const consumerCompatUsage =
  "Usage: stll-consumer-compat --packages '[\"packages/example\"]' --consumer-node <exact-patch> --fixture-path <directory>";

export const parseConsumerCompatArguments = (args: string[]) => {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))
    return { mode: "help" } as const;
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !flag ||
      !["--packages", "--consumer-node", "--fixture-path"].includes(flag) ||
      !value ||
      options.has(flag)
    )
      throw new Error(consumerCompatUsage);
    options.set(flag, value);
  }
  const encoded = options.get("--packages");
  const consumerNode = options.get("--consumer-node");
  const fixturePath = options.get("--fixture-path");
  if (!encoded || !consumerNode || !fixturePath)
    throw new Error(consumerCompatUsage);
  const packages: unknown = JSON.parse(encoded);
  if (!Array.isArray(packages) || packages.length === 0)
    throw new Error("--packages must be a nonempty JSON array");
  return {
    mode: "run",
    packages: packages.map((entry: unknown) =>
      consumerRelativePath(entry, "--packages"),
    ),
    consumerNode,
    fixturePath: consumerRelativePath(fixturePath, "--fixture-path"),
  } as const;
};
