# stella tooling

Shared TypeScript and oxlint configuration for stella public packages.

This repo intentionally contains only portable tooling policy:

- `@stll/typescript-config`: strict TypeScript config presets.
- `@stll/oxlint-config`: general upstream oxlint rules and the shared
  `stella-lowercase` JS plugin.

Repo-specific stella rules stay in the consuming repo: custom oxlint plugins,
security rules, i18n rules, generated native artifacts, benchmark exceptions,
and package-specific ignores.

## Usage

Install the shared packages:

```bash
bun add -d @stll/typescript-config @stll/oxlint-config oxlint oxlint-tsgolint typescript
```

Use the library TypeScript preset:

```json
{
  "extends": "@stll/typescript-config/library.json",
  "include": ["src"]
}
```

Use the oxlint preset with local exceptions:

```ts
import { library } from "@stll/oxlint-config";

export default library({
  ignorePatterns: ["dist/", "npm/", "*.node"],
  overrides: [
    {
      files: ["scripts/**"],
      rules: {
        "no-console": "off",
      },
    },
  ],
});
```

Use the helper directly as the root config when possible. That keeps root-level
options, shared JS plugins, shared ignores, and local exceptions in one merged
object.

If a repo needs the `extends` style used by other oxlint config packages, keep
repo-specific ignores in the root config:

```ts
import stella from "@stll/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [stella],
  ignorePatterns: ["dist/", "npm/", "*.node"],
});
```

CommonJS repos can use `require` in `oxlint.config.ts`:

```ts
const { library } = require("@stll/oxlint-config");

module.exports = library();
```

Recommended scripts:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "bun --bun oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error --deny-warnings --type-aware .",
    "lint:fix": "bun --bun oxlint -c oxlint.config.ts --type-aware --fix ."
  }
}
```
