---
"@stll/typescript-config": patch
---

List `dependency-cruiser` as a TypeScript 6 compiler-API peer blocker. Its TypeScript-based import resolution needs the TypeScript 6 compiler API, so consumers install it in an isolated tool directory with TypeScript 6 until it supports the TypeScript 7 compiler API.
