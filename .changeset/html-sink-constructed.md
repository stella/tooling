---
"@stll/oxlint-plugin": patch
---

`no-unsafe-inner-html` no longer treats `write` and `writeln` on an instance of an imported non-document class (for example a stream matcher) as document sinks. Instances of `Document`, `HTMLDocument` and `XMLDocument`, however imported, global constructors and reassigned bindings stay checked. The `stdin` of a child process is not a document either, when it belongs to a const bound to `spawn`, `fork`, `exec` or `execFile` from `node:child_process` or to the global `Bun.spawn`.
