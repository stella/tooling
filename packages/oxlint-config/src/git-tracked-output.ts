import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Stream Git's file list to disk so consumer size cannot exhaust maxBuffer. */
export const readGitTrackedOutput = (
  root: string,
  mode: "paths" | "staged",
) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "stll-git-tracked-"));
  try {
    const output = path.join(scratch, "tracked");
    const descriptor = openSync(output, "w", 0o600);
    try {
      execFileSync(
        "git",
        [
          "ls-files",
          "-z",
          ...(mode === "staged" ? ["--cached", "--stage"] : []),
        ],
        { cwd: root, stdio: ["ignore", descriptor, "inherit"] },
      );
    } finally {
      closeSync(descriptor);
    }
    return readFileSync(output, "utf8");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
