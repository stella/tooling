---
"@stll/oxlint-config": patch
---

The generated cloud setup checks Bun resolution routes through `/bin/sh` by absolute path, so a writable directory on the checked `PATH` cannot supply the shell that setup runs, and it reinstalls dependencies when `node_modules` is missing even if the lockfile stamp still matches.
