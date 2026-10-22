---
"@stll/oxlint-plugin": patch
---

`no-unsafe-inner-html` no longer treats `write` and `writeln` on the `stdin` of a child process as document sinks, when the receiver belongs to a const bound to `spawn`, `fork`, `exec` or `execFile` from `node:child_process` or to the global `Bun.spawn`. A never-reassigned class or function declaration is no longer a possible DOM target, so `Object.assign(Factory, source)` is not checked as an HTML sink. Instances of imported classes stay checked, because an import does not prove that a class is not a document.
