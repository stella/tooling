---
"@stll/oxlint-config": patch
---

The publish target resolver supports tsdown 0.23.1 and Vite 8.3.4, and the declaration-only Vite adapter supports vite-plugin-dts 5.1.2 with unplugin-dts 1.1.2. The resolved build fields it reads are unchanged, and tsdown 0.23's removed declaration options are not used by any shared build configuration.
