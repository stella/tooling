---
"@stll/oxlint-config": minor
---

The shared Dependabot policy gathers first-party reusable workflow refs into one ordered GitHub Actions group, so they update together, and the approved `actions/setup-node`, `actions/upload-artifact` and `actions/download-artifact` pins move to v7.1.0, v7.0.2 and v8.0.2. Dependabot also leaves the consumer package managers (`npm`, `pnpm`) to reviewed toolchain changes.
