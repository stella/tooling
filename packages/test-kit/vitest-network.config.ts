import { defineConfig } from "vitest/config";

import shared from "./vitest.config.js";

export default defineConfig({
  ...shared,
  test: {
    ...shared.test,
    include: ["test/preload/*.test.ts"],
    setupFiles: ["./src/vitest/forbid-network.ts"],
  },
});
