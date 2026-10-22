---
"@stll/oxlint-plugin": patch
---

`no-unsafe-inner-html` checks each branch of a conditional or logical `Object.assign` source instead of treating the whole expression as opaque, so `Object.assign(target, ready ? {} : { handler })` passes while an HTML key or an opaque value in either branch is still reported.
