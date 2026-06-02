## Repository Specifics

This repository publishes Stella shared TypeScript and oxlint configuration packages. Changes here affect many public repositories, so compatibility matters more than local convenience.

### Commands

- `bun install`
- `bun run lint`
- `bun run typecheck`
- `bun test`
- `bun run build`
- `bun run publint`
- `bun run pack:dry-run`

### Working Rules

- Keep config exports stable and documented; consumers import these packages directly.
- Do not add stricter lint rules without checking the public repos that consume them.
- Prefer typed config helpers over copied JSON fragments.
- Fixture files should prove rule behavior and make unused disables fail when a rule regresses.
