import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, realpath, stat, unlink } from "node:fs/promises";
import path, { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const diagnosticLocation = (file: string, repo: string) => {
  const normalized = file.replaceAll("\\", "/");
  const bundled = /^bundled:\/\/\/libs\/(lib\.[^/]+\.d\.ts)$/.exec(normalized);
  const installed =
    /(?:^|\/)node_modules\/(?:typescript|@typescript\/(?:native|typescript-[^/]+))\/(?:.*\/)?(lib\.[^/]+\.d\.ts)$/.exec(
      normalized,
    );
  const library = bundled?.at(1) ?? installed?.at(1);
  return library === undefined
    ? relative(repo, resolve(repo, file)).replaceAll("\\", "/")
    : `<lib>/${library}`;
};
const globalDiagnosticKey = (code: string, message: string) =>
  `<config>:0:${code}:${message.trim().replaceAll(/\s+/g, " ")}`;

/** Normalizes checker output to sorted `file:line:code` keys. */
export const diagnosticSet = (output: string, repo: string): string[] => {
  const clean = stripVTControlCharacters(output);
  const diagnostics = new Set<string>();
  for (const block of clean.matchAll(/<error\b([^>]*)>([\s\S]*?)<\/error>/g)) {
    const attributes = new Map(
      [...(block.at(1) ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((match) => [
        match.at(1),
        match.at(2),
      ]),
    );
    const file = attributes.get("file");
    const row = attributes.get("line");
    const code = attributes.get("code");
    if (code === undefined || !/^TS\d+$/.test(code)) continue;
    if (file !== undefined && row !== undefined && row !== "0")
      diagnostics.add(
        `${diagnosticLocation(file, repo)}:${row}:${code.slice(2)}`,
      );
    else {
      const message =
        (block.at(2) ?? "").split(/<(?:source|related)\b/).at(0) ?? "";
      diagnostics.add(globalDiagnosticKey(code.slice(2), message));
    }
  }
  for (const rawLine of clean.split("\n")) {
    const line = rawLine.replace(
      /^(?!(?:error|warning) TS\d+:)(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]* [a-zA-Z0-9_.:-]+: /,
      "",
    );
    if (line.startsWith("<error ")) continue;
    const match =
      /^(.*?)\((\d+),\d+\):\s*(?:error|warning) TS(\d+)/.exec(line) ??
      /^(.*?):(\d+):\d+:\s*(?:error|warning) (?:TS)?(\d+)/.exec(line);
    if (match) {
      const [, file = "", row = "", code = ""] = match;
      diagnostics.add(`${diagnosticLocation(file, repo)}:${row}:${code}`);
    } else {
      const global = /^(?:error|warning) TS(\d+):\s*(.*)/.exec(line);
      if (global)
        diagnostics.add(
          globalDiagnosticKey(global.at(1) ?? "", global.at(2) ?? ""),
        );
    }
  }
  return [...diagnostics].sort();
};

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
    // Workspace runners may report compiler paths from the declared project.
    // Only the exact owned seed under either known command origin is accepted.
    const origins = new Set([root, dirname(config)]);
    const attributed = [...origins].some((origin) =>
      diagnosticSet(seeded.output, origin).includes(
        `${relative(origin, seed).replaceAll("\\", "/")}:1:2322`,
      ),
    );
    if (!attributed)
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
