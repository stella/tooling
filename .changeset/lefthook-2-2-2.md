---
"@stll/oxlint-config": patch
---

The toolchain pins lefthook 2.2.2. From 2.2.1 lefthook keeps the hidden unstaged changes of each linked worktree in its own patch file, and 2.2.2 drops only the stash it created, so worktrees of one repository can run pre-commit at the same time.
