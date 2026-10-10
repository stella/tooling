export const parityUsage =
  "Usage: stll-typecheck-parity [--project <tsconfig>]... (run from repository root)\n       stll-typecheck-parity --help";

type ParityArguments =
  | { mode: "help" }
  | { mode: "default" }
  | { mode: "selected"; projects: string[] };
export const parseParityArguments = (
  args: readonly string[],
): ParityArguments => {
  if (args.length === 1 && args.at(0) === "--help") return { mode: "help" };
  const projects: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const project = args.at(index + 1);
    if (
      args.at(index) !== "--project" ||
      project === undefined ||
      project.trim() === "" ||
      project.startsWith("--")
    )
      throw new Error(parityUsage);
    projects.push(project);
    index += 1;
  }
  return projects.length === 0
    ? { mode: "default" }
    : { mode: "selected", projects };
};
