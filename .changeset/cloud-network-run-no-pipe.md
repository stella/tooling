---
"@stll/oxlint-config": patch
---

Write cloud setup network command output to a file instead of a pipe, and end processes left holding that log once the command exits, so package scripts cannot hold a setup step open.
