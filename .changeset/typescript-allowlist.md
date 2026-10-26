---
"@stll/oxlint-config": major
---

The shared TypeScript 6 peer-blocker list is gone (`typescript6Compatibility` is removed from `toolchain.json`). By default no manifest, catalog, override or resolution may declare `typescript`, `@typescript/native` or an `npm:typescript@…` alias. A repository that needs an install for one of its tools declares it in `typescriptAllowlist` in its own `stll-toolchain.json`, with the workspace (`.` for the root), the declared name, the exact spec, the dependency in that workspace that needs it, and a reason:

```json
{
  "typescriptAllowlist": [
    {
      "workspace": "apps/docs",
      "name": "typescript",
      "spec": "6.0.3",
      "dependency": "@astrojs/check",
      "reason": "astro check loads the TypeScript 6 language service."
    }
  ]
}
```

The spec may be any version, declared directly or through a catalog that resolves to it. An undeclared install fails with the entry to add, and an entry fails when its spec differs or when its workspace no longer declares the name or the dependency. Overrides and resolutions may not declare TypeScript. Repositories that kept `typescript` 6.0.3 beside a former peer blocker add one entry per workspace.

`typescript-compat` is no longer a shared Dependabot ignore: regenerate `.github/dependabot.yml` with `stll-dependabot`, and declare an alias you keep in `dependabotIgnores`.
