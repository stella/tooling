---
"@stll/test-kit": patch
---

The README explains how a test's own timeout interacts with `bun test --timeout`: the test's number replaces the command's in either direction, so a long test sized from a workstation run can fail on slower CI runners inside a budget the command allows. It recommends one budget sized from CI durations and per-phase hang guards with `settledWithin`.
