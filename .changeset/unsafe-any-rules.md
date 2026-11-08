---
"@stll/oxlint-config": major
"@stll/test-kit": patch
---

`library()` enables `typescript/no-unsafe-argument`, `no-unsafe-assignment`, `no-unsafe-call`, `no-unsafe-member-access` and `no-unsafe-return`, so an `any` from `JSON.parse`, untyped libraries or an unresolved import can no longer flow into typed code unchecked. Test files keep reporting calls, member access and returns but allow passing and storing `any` values such as asymmetric matchers. JavaScript files are exempt. The rules are exported as `unsafeAnyRules` so a consumer can turn them off per directory while adopting them, and the two exemptions as `unsafeAnyOverrides`; `libraryOverrides` does not include them, so a config that spreads it over another preset keeps that preset's scope for these rules.
