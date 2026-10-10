import { detectToolchainChanges } from "./toolchain-changed";

type ParitySelectionOptions = {
  repo: string;
  since?: string | undefined;
  run: () => Promise<boolean>;
  detect?: typeof detectToolchainChanges;
  output?: (text: string) => void;
};

/** CI forcing considers every tool; expensive compiler parity considers Bun and TS. */
export const runSelectedTypecheckParity = async ({
  repo,
  since,
  run,
  detect = detectToolchainChanges,
  output = (text) => process.stdout.write(text),
}: ParitySelectionOptions) => {
  if (since === undefined) return run();
  const result = await detect({ repo, since });
  if (result.status === "unreadable") return run();
  if (result.tools.some((tool) => tool === "bun" || tool === "typescript"))
    return run();
  output(
    `parity skipped: toolchain unchanged since ${since} (bun ${result.current.bun.join(", ") || "not declared"}, typescript ${result.current.typescript.join(", ") || "not declared"})\n`,
  );
  return true;
};
