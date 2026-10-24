# Contributing

Thanks for helping! searvia is a small, dependency-free TypeScript CLI.

## Setup

```bash
git clone https://github.com/searvia/searvia-cli.git
cd searvia-cli
npm install
npm run build && node dist/index.js --help
```

## Checks (the same as CI)

```bash
npm run lint        # Biome
npm run typecheck   # tsc --noEmit
npm test            # Vitest, fetch is mocked: no network, no real keys
```

## Rules of thumb

- **No runtime dependencies.** Use Node built-ins (`fetch`, `crypto`, `zlib`, `fs`). Dev dependencies are fine.
- **Verify every store endpoint** against the official docs before using it (App Store Connect OpenAPI spec:
  https://developer.apple.com/documentation/appstoreconnectapi, Google Play discovery document:
  https://androidpublisher.googleapis.com/$discovery/rest?version=v3) and add a test with a mocked `fetch` that
  asserts the exact method, path and body.
- **Writes are dry runs by default.** A new write path must print what it would change and only act with `--yes`.
- **`--json` stays parseable:** human output goes through `Output`, never `console.log`.
- The ASO rules in `src/aso/` mirror Searvia's server-side rules. Change them together with a test that shows the
  behaviour (Turkish and CJK samples are welcome).
- Keep credentials out of logs. Pre-signed URLs are redacted by `redact()`.

## Commits and releases

Conventional, imperative commit messages (`Add Play in-app products to pull`). Releases are cut by tagging `vX.Y.Z`;
the release workflow publishes to npm with provenance. Update `CHANGELOG.md` and `src/version.ts` with the version.
