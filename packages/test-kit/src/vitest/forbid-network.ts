import { afterAll } from "vitest";

import { installNetworkGuard } from "../network.js";

// setupFiles runs once per file; release process-wide transports at its end.
afterAll(installNetworkGuard());
