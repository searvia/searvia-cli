# AGENTS.md

Guidance for coding agents.

- **Using the CLI** (shipping apps, editing store metadata, ASO): read [SKILL.md](./SKILL.md). Always dry-run first;
  add `--yes` only after the user approved the printed diff.
- **Working on this repository:**
  - TypeScript ESM, Node ≥ 20, **no runtime dependencies**. Source in `src/`, tests in `test/` (Vitest, `fetch` is
    stubbed — tests never touch the network).
  - Checks: `npm run lint && npm run typecheck && npm test`; build with `npm run build`.
  - Layout: `src/core` (args, config, http, jwt, yaml, output, diff), `src/aso` (offline rules), `src/apple` (App Store
    Connect), `src/play` (Google Play), `src/searvia` (MCP client), `src/metadata` (fastlane folders),
    `src/commands` (one file per command group), `src/cli.ts` (dispatcher).
  - Every store call must match the official API reference; add a mocked-fetch test asserting method, path and body.
  - Human output goes through `Output` so `--json` stays a single document.
