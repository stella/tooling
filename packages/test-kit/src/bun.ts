import { afterEach, beforeEach } from "bun:test";

import { createTestTmpDirSlot, type TestTmpDir } from "./tmp.js";

/**
 * Registers a fresh directory for each serial test in the current scope.
 * Concurrent tests use `withTestTmpDir` from the runner-independent tmp module.
 */
export const useTestTmpDir = (prefix?: string): (() => TestTmpDir) => {
  const slot = createTestTmpDirSlot(prefix);
  beforeEach(slot.open);
  afterEach(slot.close);
  return slot.current;
};
