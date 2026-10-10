export const changedUsage =
  "Usage: stll-toolchain-changed --since <git-ref>\n       stll-toolchain-changed --help";

export const parseChangedArguments = (args: readonly string[]) => {
  if (args.length === 1 && args.at(0) === "--help")
    return { mode: "help" } as const;
  const since = args.at(1);
  if (
    args.length !== 2 ||
    args.at(0) !== "--since" ||
    since === undefined ||
    since.trim() === "" ||
    since.startsWith("-")
  )
    throw new Error(changedUsage);
  return { mode: "compare", since } as const;
};
