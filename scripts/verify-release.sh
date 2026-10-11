#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Neither CI nor Publish may reuse outputs from an earlier build.
rm -rf packages/oxlint-config/dist packages/oxlint-plugin/dist
bun run build
bun run check:lockfile-versions
bun run check:registry-versions
bun run typecheck
bun run test
bun run lint
bun run publint
