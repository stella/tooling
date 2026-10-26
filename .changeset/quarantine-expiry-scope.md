---
"@stll/oxlint-config": minor
---

Overdue dated entries (temporary quarantine excludes in `bunfig.toml` and `rustExceptions` in `stll-toolchain.json`) no longer fail pull requests and merge groups that leave them untouched. `stll-toolchain-check` and `stll-quarantine --check` fail every overdue entry on pushes, schedules, dispatches and non-GitHub CI. On pull requests and merge groups they fail only entries the change adds or edits, compared with the event's base commit (fetched on demand in shallow checkouts), and warn about inherited ones. Local runs warn.
