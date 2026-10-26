---
"@stll/oxlint-config": minor
---

Cloud setup verifies Node and Bun archives against SHA256 values recorded at generation time. The shared policy records them for its own releases; a repository on another accepted Node patch or a newer Bun records that release's values in `cloud.runtimeArchiveSha256`. Local package archives now download under the network deadline, and their installation, package triggers and maintainer scripts run without one.
