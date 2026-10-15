import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["test/*.test.ts", "test/vitest/*.test.ts"],
    alias: [
      {
        find: /^.*\/runner\.js$/,
        replacement: fileURLToPath(
          new URL("./test/runner.vitest.ts", import.meta.url),
        ),
      },
    ],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
