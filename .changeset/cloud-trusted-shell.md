---
"@stll/oxlint-config": patch
---

The generated cloud setup checks Bun resolution routes through `/bin/sh` by absolute path, so a writable directory on the checked `PATH` cannot supply the shell that setup runs, and it reinstalls dependencies when `node_modules` is missing even if the lockfile stamp still matches. Route checks run after the shell profile is installed, so login routes never read a previous profile, and the image Bun replacement reaches the last `PATH` entry.
