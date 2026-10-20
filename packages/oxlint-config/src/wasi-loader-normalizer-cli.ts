#!/usr/bin/env node
import { runWasiLoaderNormalizer } from "./wasi-loader-normalizer";

runWasiLoaderNormalizer(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `wasi-loader-normalizer: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
