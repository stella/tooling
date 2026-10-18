---
"@stll/oxlint-plugin": minor
---

Add test reliability rules for test files: `no-wall-clock-in-tests`, `no-real-timer-waits-in-tests`, `no-unseeded-random-in-tests`, `no-real-network-in-tests` and `no-checkout-writes-in-tests`. Each points to the matching `@stll/test-kit` primitive. They are exported but not enabled by any preset.
