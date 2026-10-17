import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

// This worker imports only Node builtins. Package code is never loaded.
const worker = String.raw`
import {createRequire, isBuiltin} from 'node:module';
import {readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';
const selfReference = (specifier, file) => {
  let directory = path.dirname(file);
  while (true) {
    const manifest = path.join(directory, 'package.json');
    if (existsSync(manifest)) {
      const {name} = JSON.parse(readFileSync(manifest, 'utf8'));
      return typeof name === 'string' &&
        (specifier === name || specifier.startsWith(name + '/'));
    }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
};
const bare = specifier => typeof specifier === 'string' &&
  !specifier.startsWith('.') && !specifier.startsWith('/') &&
  !specifier.startsWith('#') && !specifier.includes(':');
for await (const line of createInterface({input: process.stdin})) {
  const {specifier, file, mode} = JSON.parse(line);
  try {
    const resolved = mode === 'require'
      ? createRequire(file).resolve(specifier)
      : import.meta.resolve(specifier, pathToFileURL(file).href);
    console.log(JSON.stringify({url: isBuiltin(resolved) ||
      (bare(specifier) && !selfReference(specifier, file)) ? null :
      mode === 'require' ? pathToFileURL(resolved).href : resolved}));
  } catch (error) {
    // Node reports the selected missing dependency, including external #imports
    // targets. Never reinterpret its exports/imports selection ourselves.
    const missing = /^Cannot find (?:package|module) '([^']+)'/.exec(error.message)?.[1];
    if (bare(missing) && !selfReference(missing, file) &&
      ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(error.code))
      console.log(JSON.stringify({url: null}));
    else console.log(JSON.stringify({error: String(error)}));
  }
}
`;

type NodeResolution = {
  specifier: string;
  file: string;
  mode: "import" | "require";
};

/** One metadata-only Node process per archive, with default import/require conditions. */
export const createPackedNodeResolver = () => {
  const child = spawn(
    "node",
    [
      "--experimental-import-meta-resolve",
      "--input-type=module",
      "--eval",
      worker,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 16_384) stderr += chunk;
  });
  child.on("error", (error) => child.stdout.destroy(error));
  const output = createInterface({ input: child.stdout });
  const lines = output[Symbol.asyncIterator]();
  return {
    resolve: async (request: NodeResolution) => {
      const timeout = setTimeout(() => child.kill(), 10_000);
      try {
        child.stdin.write(`${JSON.stringify(request)}\n`);
        const line = await lines.next();
        if (line.done === true)
          throw new Error(`Node resolver stopped: ${stderr}`);
        const response: unknown = JSON.parse(line.value);
        if (typeof response !== "object" || response === null)
          throw new Error("Invalid Node resolver response");
        if ("error" in response && typeof response.error === "string")
          throw new Error(response.error);
        if (
          !("url" in response) ||
          (response.url !== null && typeof response.url !== "string")
        )
          throw new Error("Invalid Node resolver URL");
        return response.url;
      } finally {
        clearTimeout(timeout);
      }
    },
    close: async () => {
      output.close();
      if (
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    },
  };
};
