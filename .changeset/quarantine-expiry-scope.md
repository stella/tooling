---
"@stll/oxlint-config": minor
---

Overdue temporary quarantine excludes no longer fail pull requests and merge groups that leave them untouched. `stll-toolchain-check` and `stll-quarantine --check` fail every overdue entry on pushes, schedules, dispatches and non-GitHub CI; on pull requests and merge groups they fail only entries the change adds or edits, compared with the event's base commit, and warn about inherited ones. Local runs warn.
