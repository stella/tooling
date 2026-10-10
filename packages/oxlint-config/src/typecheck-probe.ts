import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, realpath, stat, unlink } from "node:fs/promises";
import path, { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { diagnosticSet } from "./typecheck-parity";

type ProbeCommandOptions = {
  command: readonly string[];
  cwd: string;
  signal: AbortSignal;
};
type ProbeCommandResult = { status: number | null; output: string };

const runProbeCommand = ({ command, cwd, signal }: ProbeCommandOptions) =>
  new Promise<ProbeCommandResult>((done, reject) => {
    const executable = command.at(0);
    if (executable === undefined) {
      reject(new Error("typecheck probe command is empty"));
      return;
    }
    const child = spawn(executable, command.slice(1), {
      cwd,
      signal,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (status) => done({ status, output }));
  });

type ProbePathContainmentOptions = {
  root: string;
  candidate: string;
  paths?: Pick<typeof path, "relative" | "isAbsolute" | "sep">;
};

export const insideProbePath = ({
  root,
  candidate,
  paths = path,
}: ProbePathContainmentOptions) => {
  const location = paths.relative(root, candidate);
  return (
    location !== ".." &&
    !location.startsWith(".." + paths.sep) &&
    !paths.isAbsolute(location)
  );
};

type RunTypecheckProbeOptions = {
  repo: string;
  project: string;
  seedDirectory?: string | undefined;
  command: readonly string[];
  output?: (text: string) => void;
  run?: (options: ProbeCommandOptions) => Promise<ProbeCommandResult>;
};

export const runTypecheckProbe = async ({
  repo,
  project,
  seedDirectory,
  command,
  output,
  run = runProbeCommand,
}: RunTypecheckProbeOptions) => {
  const executable = command.at(0);
  if (
    executable === undefined ||
    executable === "" ||
    command.some((argument) => argument.includes("\0"))
  )
    throw new Error(
      "typecheck probe requires a nonempty command argv without NUL bytes",
    );
  if (project === "")
    throw new Error("typecheck probe requires an explicit project file");
  const root = await realpath(repo);
  const requested = resolve(root, project);
  if (!insideProbePath({ root, candidate: requested }))
    throw new Error(
      `typecheck probe project is outside the repository: ${project}`,
    );
  const config = await realpath(requested);
  if (!insideProbePath({ root, candidate: config }))
    throw new Error(
      `typecheck probe project resolves outside the repository: ${project}`,
    );
  if (!(await stat(config)).isFile())
    throw new Error(`typecheck probe project must be a file: ${project}`);
  let seedParent = dirname(config);
  if (seedDirectory !== undefined) {
    if (seedDirectory === "" || isAbsolute(seedDirectory))
      throw new Error(
        "typecheck probe seed directory must be repository-relative",
      );
    const requestedSeedParent = resolve(root, seedDirectory);
    if (!insideProbePath({ root, candidate: requestedSeedParent }))
      throw new Error(
        `typecheck probe seed directory is outside the repository: ${seedDirectory}`,
      );
    seedParent = await realpath(requestedSeedParent);
    if (
      !insideProbePath({ root, candidate: seedParent }) ||
      !insideProbePath({ root: dirname(config), candidate: seedParent })
    )
      throw new Error(
        `typecheck probe seed directory must be inside the declared project: ${seedDirectory}`,
      );
    if (!(await stat(seedParent)).isDirectory())
      throw new Error(
        `typecheck probe seed directory must be a directory: ${seedDirectory}`,
      );
  }
  const seed = join(seedParent, `stll-typecheck-probe-${randomUUID()}.ts`);
  const seedLocation = relative(root, seed).replaceAll("\\", "/");
  const controller = new AbortController();
  const interrupt = (signal: string) =>
    controller.abort(new Error(`typecheck probe interrupted by ${signal}`));
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  let created = false;
  const removeSeed = async () => {
    if (!created) return;
    await unlink(seed);
    created = false;
  };
  const execute = async () => {
    controller.signal.throwIfAborted();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_done, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([
        run({ command, cwd: root, signal: controller.signal }),
        aborted,
      ]);
      controller.signal.throwIfAborted();
      output?.(result.output);
      return result;
    } finally {
      if (onAbort !== undefined)
        controller.signal.removeEventListener("abort", onAbort);
    }
  };
  try {
    controller.signal.throwIfAborted();
    const file = await open(seed, "wx", 0o600);
    created = true;
    try {
      await file.writeFile('export const typecheckProbe: number = "wrong";\n');
    } finally {
      await file.close();
    }
    const seeded = await execute();
    if (seeded.status === null || seeded.status === 0)
      throw new Error(
        `typecheck probe expected the seeded command to fail: ${seedLocation}`,
      );
    if (!diagnosticSet(seeded.output, root).includes(`${seedLocation}:1:2322`))
      throw new Error(
        `typecheck probe expected TS2322 attributed to ${seedLocation}; the declared project may exclude the seed`,
      );
    await removeSeed();
    const clean = await execute();
    if (clean.status !== 0)
      throw new Error(
        `typecheck probe clean command failed with status ${clean.status ?? "unknown"}: ${project}`,
      );
  } finally {
    try {
      await removeSeed();
    } finally {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
    }
  }
};
