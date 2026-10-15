import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

const installTargetSeconds = 240;

const command = async (args: string[], cwd: string) => {
  const child = Bun.spawn(args, {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `Command failed (${exitCode}): ${JSON.stringify(args)}\n${stderr.replace(/(?:postgres(?:ql)?|rediss?):\/\/[^\s"']+/gi, "[local connection redacted]")}`,
    );
  return stdout.trim();
};

const main = async () => {
  if (process.env["CI"] !== "true" || process.platform !== "linux")
    throw new Error("This consumer integration runs only in Linux CI");
  const release = await readFile("/etc/os-release", "utf8");
  if (!/^ID=ubuntu$/m.test(release) || !/^VERSION_ID="24\.04"$/m.test(release))
    throw new Error("Ubuntu 24.04 is required");
  const args = process.argv.slice(2);
  const input = args.at(0);
  if (args.length !== 1 || input === undefined || input.startsWith("-"))
    throw new Error(
      "Usage: bun scripts/cloud-setup-consumer-integration.ts /disposable/consumer-snapshot",
    );
  const snapshot = await realpath(input);
  const source = resolve(import.meta.dirname, "..");
  if (snapshot === source)
    throw new Error(
      "Supply a disposable consumer snapshot, not the tooling checkout",
    );
  for (const file of [
    "stll-toolchain.json",
    ".node-version",
    "package.json",
    "bun.lock",
  ])
    if (!existsSync(join(snapshot, file)))
      throw new Error(`Consumer snapshot requires ${file}`);

  // Archive snapshots need an index because generation reads tracked declarations.
  if (!existsSync(join(snapshot, ".git")))
    await command(["git", "init", "--quiet"], snapshot);
  if (
    (await realpath(
      await command(["git", "rev-parse", "--show-toplevel"], snapshot),
    )) !== snapshot
  )
    throw new Error(
      "The consumer snapshot must be its own Git repository root",
    );
  const identity = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], {
    cwd: snapshot,
    stdout: "pipe",
    stderr: "ignore",
  });
  process.stdout.write(`Consumer snapshot: ${snapshot}\n`);
  process.stdout.write(
    `Consumer HEAD: ${identity.exitCode === 0 ? identity.stdout.toString().trim() : "unavailable (archive snapshot)"}\n`,
  );
  const inputs = [
    "stll-toolchain.json",
    ".node-version",
    "package.json",
    "bun.lock",
    "rust-toolchain.toml",
    "rust-toolchain",
    "Cargo.lock",
  ].filter((file) => existsSync(join(snapshot, file)));
  await command(["git", "add", "--force", "--", ...inputs], snapshot);
  await command(
    [
      process.execPath,
      join(source, "packages/oxlint-config/src/cloud-setup-cli.ts"),
    ],
    snapshot,
  );
  const script = join(snapshot, ".agents/cloud-setup.sh");
  const measure = async (
    phase: "first install" | "cached install" | "start",
  ) => {
    process.stdout.write(`Running consumer ${phase}\n`);
    const started = performance.now();
    await command(
      ["bash", script, phase === "start" ? "start" : "install"],
      snapshot,
    );
    const seconds = (performance.now() - started) / 1000;
    process.stdout.write(`Consumer ${phase}: ${seconds.toFixed(2)} seconds\n`);
    return seconds;
  };
  process.stdout.write(
    "First-install timing requires a clean container; this harness does not clear existing installations or caches.\n",
  );
  const firstInstallSeconds = await measure("first install");
  const cachedInstallSeconds = await measure("cached install");
  const startSeconds = await measure("start");
  process.stdout.write(
    `${JSON.stringify({
      firstInstallSeconds,
      cachedInstallSeconds,
      startSeconds,
      installTargetSeconds,
      installTarget:
        firstInstallSeconds < installTargetSeconds ? "met" : "exceeded",
    })}\n`,
  );
};

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Consumer integration failed"}\n`,
  );
  process.exitCode = 1;
});
