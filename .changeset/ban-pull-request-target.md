---
"@stll/oxlint-config": minor
---

`stll-toolchain-check` rejects the `pull_request_target` workflow trigger with the new mandatory `workflow-trigger` rule. It has no allowlist or opt-out: use an unprivileged `pull_request` workflow and, only for a step that needs secrets or write access, a separate `workflow_run` workflow that treats the first run's output as untrusted data.
