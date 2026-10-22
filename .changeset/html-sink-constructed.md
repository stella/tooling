---
"@stll/oxlint-plugin": patch
---

`no-unsafe-inner-html` no longer treats `write` and `writeln` on an instance of an imported non-document class (for example a stream matcher) as document sinks. Instances of `Document`, `HTMLDocument` and `XMLDocument`, however imported, global constructors and reassigned bindings stay checked.
