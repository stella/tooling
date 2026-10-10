export const parityUsage =
  "Usage: stll-typecheck-parity [--changed-since <git-ref>] [--project <tsconfig>]... (run from repository root)\n       stll-typecheck-parity --help";

type ParityArguments =
  | { mode: "help" }
  | { mode: "default"; changedSince?: string }
  | { mode: "selected"; projects: string[]; changedSince?: string };
export const parseParityArguments = (
  args: readonly string[],
): ParityArguments => {
  if (args.length === 1 && args.at(0) === "--help") return { mode: "help" };
  const projects: string[] = [];
  let changedSince: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const project = args.at(index + 1);
    const option = args.at(index);
    if (
      (option !== "--project" && option !== "--changed-since") ||
      project === undefined ||
      project.trim() === "" ||
      project.startsWith("--")
    )
      throw new Error(parityUsage);
    if (option === "--project") projects.push(project);
    else {
      if (changedSince !== undefined) throw new Error(parityUsage);
      changedSince = project;
    }
    index += 1;
  }
  return projects.length === 0
    ? {
        mode: "default",
        ...(changedSince === undefined ? {} : { changedSince }),
      }
    : {
        mode: "selected",
        projects,
        ...(changedSince === undefined ? {} : { changedSince }),
      };
};
