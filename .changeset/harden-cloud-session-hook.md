---
"@stll/oxlint-config": minor
---

Resolve the generated Claude SessionStart hook through `$CLAUDE_PROJECT_DIR` so it
runs from repository subdirectories; regeneration replaces the previous
relative-path hook. Generated Claude settings set empty commit and pull request
attribution, and `cloud-setup-drift` enforces both. Add GNU time (`/usr/bin/time`)
from Ubuntu's `time` package as an optional cloud tool.
