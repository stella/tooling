export const probeUsage =
  "Usage: stll-typecheck-probe --project <tsconfig> [--seed-dir <directory>] -- <command> [args...]\n       stll-typecheck-probe --help";

export const parseProbeArguments = (args: readonly string[]) => {
  if (args.length === 1 && args.at(0) === "--help")
    return { mode: "help" } as const;
  const project = args.at(1);
  const seedDirectory = args.at(2) === "--seed-dir" ? args.at(3) : undefined;
  const separator = seedDirectory === undefined ? 2 : 4;
  const command = args.slice(separator + 1);
  if (
    args.at(0) !== "--project" ||
    project === undefined ||
    project.trim() === "" ||
    project.startsWith("-") ||
    args.at(separator) !== "--" ||
    (seedDirectory !== undefined &&
      (seedDirectory.trim() === "" || seedDirectory.startsWith("-"))) ||
    command.length === 0 ||
    command.some((value) => value.trim() === "")
  )
    throw new Error(probeUsage);
  return {
    mode: "probe",
    project,
    command,
    ...(seedDirectory === undefined ? {} : { seedDirectory }),
  } as const;
};
