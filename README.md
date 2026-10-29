# searvia

**Ship iOS and Android apps from the terminal.** Store listings, screenshots, builds, review submission and staged
rollouts for **App Store Connect** and **Google Play**, plus an **offline ASO audit** — from start to finish without
opening App Store Connect or the Play Console.

```bash
npx searvia audit            # works right now, no keys needed
```

- **Zero runtime dependencies.** Node ≥ 20 built-ins only (fetch, crypto, zlib). MIT licensed.
- **Fastlane-compatible folders.** Point it at your existing `fastlane/metadata` and `fastlane/screenshots`.
- **Safe by default.** Every write is a dry run that prints a field-by-field diff until you add `--yes`.
- **CI-first.** `--json` on every command, meaningful exit codes, credentials from environment variables, no Xcode
  needed to upload builds (App Store Connect build upload API) — runs on `ubuntu-latest`.
- **Your keys stay on your machine.** They are only ever sent to Apple, Google and (for the optional Searvia
  commands) Searvia.

[Türkçe README](./README.tr.md) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [Agent skill](./SKILL.md) · [Workflow skills](./skills/README.md)

---

## Quick start

```bash
npm install -g searvia        # or use npx searvia <command>
cd my-app
searvia init                  # detects fastlane folders, Appfile, applicationId; writes searvia.config.json
searvia doctor                # checks that the keys work (read-only)
searvia pull                  # download every localization into fastlane/metadata
searvia audit                 # ASO score per locale, with concrete fixes
searvia push                  # see the diff …
searvia push --yes            # … and apply it
searvia release --platform ios --ipa build/App.ipa --yes
searvia release --platform android --aab app-release.aab --rollout 10 --yes
```

### Credentials

| Store | What you need | Where it goes |
|---|---|---|
| App Store Connect | API key (Users and Access › Integrations › App Store Connect API), role **App Manager**. Team keys have an issuer id; individual keys don't. | `.searvia/config.json` (`ios.keyId`, `ios.issuerId`, `ios.privateKeyPath`) or `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` (file contents) / `ASC_PRIVATE_KEY_PATH` |
| Google Play | Service account JSON key (Google Cloud › IAM › Service accounts), invited in Play Console › Users and permissions with release + store listing permissions. | `.searvia/config.json` (`android.serviceAccountPath`) or `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (contents) / `GOOGLE_PLAY_SERVICE_ACCOUNT_PATH` |
| Searvia (optional) | API key from [searvia.com/settings/api](https://searvia.com/settings/api) (free account at [searvia.com](https://searvia.com)) | `searvia login` (stored in `~/.config/searvia/credentials.json`, mode 600) or `SEARVIA_API_KEY` |

Other environment variables: `ASC_APP_ID`, `ASC_BUNDLE_ID`, `GOOGLE_PLAY_PACKAGE_NAME`, `SEARVIA_URL`,
`SEARVIA_DEMO_PASSWORD` (App Review demo account), `NO_COLOR`, `SEARVIA_NO_HINTS`.

### Config

`searvia.config.json` (commit it) and `.searvia/config.json` (git-ignored by `init`) are merged; environment
variables win. A JSON schema ships in the package (`schema/config.schema.json`).

```json
{
  "$schema": "https://unpkg.com/searvia/schema/config.schema.json",
  "metadataPath": "fastlane/metadata",
  "screenshotsPath": "fastlane/screenshots",
  "ios": {
    "bundleId": "com.example.budget",
    "countries": ["US", "TR"],
    "brand": ["Cebbin"],
    "avoid": ["mint", "ynab"],
    "usesNonExemptEncryption": false,
    "releaseType": "AFTER_APPROVAL",
    "phasedRelease": true,
    "review": { "firstName": "Ada", "lastName": "Lovelace", "email": "review@example.com", "phone": "+1 555 0100", "demoUser": "demo@example.com" },
    "ageRating": { "gambling": false, "violenceCartoonOrFantasy": "NONE" }
  },
  "android": { "packageName": "com.example.budget", "track": "production", "keywords": ["budget planner", "expense tracker"] }
}
```

### Folder layout (same as fastlane deliver/supply)

```
fastlane/metadata/
  copyright.txt
  review_information/{first_name,last_name,phone_number,email_address,demo_user,notes}.txt
  en-US/{name,subtitle,keywords,description,promotional_text,release_notes,support_url,marketing_url,privacy_url}.txt
  tr/…
  android/
    en-US/{title,short_description,full_description,video}.txt
    en-US/changelogs/{<versionCode>,default}.txt
    en-US/images/{icon,featureGraphic,tvBanner}.png
    en-US/images/{phoneScreenshots,sevenInchScreenshots,tenInchScreenshots,tvScreenshots,wearScreenshots}/*.png
fastlane/screenshots/
  en-US/01.png …                 # display type detected from the pixel size
  en-US/APP_IPAD_PRO_129/01.png  # or named explicitly
```

Only fields that have a file take part in `push`, so you can manage a subset (e.g. only `keywords.txt`).

---

## Commands

Every command accepts `--json`, `--yes/-y`, `--config <file>`, `--verbose`, `--no-color` and `--help`.
Most store commands accept `--platform ios|android|all` (default: every configured store).

| Command | What it does | Status |
|---|---|---|
| `init` | Writes the configs, detects `fastlane/metadata`, `fastlane/Appfile`, Gradle `applicationId` and `AuthKey_*.p8`, git-ignores `.searvia/` and key files. Interactive in a terminal, flags in CI. | complete |
| `doctor` | Read-only check of config, folders, App Store Connect key, Play service account and Searvia login. | complete |
| `pull` | All localizations and text fields: name, subtitle, keywords, description, promotional text, What's New, support/marketing/privacy URLs, copyright; Play title, short/full description, video, release notes of the track. `--locale`, `--version`, `--track`. | complete |
| `push` | Field-by-field diff, then (with `--yes`) writes. App Store: editable version (promotional text also to the live version, which Apple allows without review), name/subtitle to the editable app info; `--create-locales`, `--create-version x.y.z`. Play: one edit, PATCH/PUT listings, commit (`--changes-not-sent-for-review`). Refuses texts over store limits unless `--force`. | complete |
| `audit` | Offline ASO audit, 0–100 per locale (see below). `--fix` repacks `keywords.txt`; `--min-score` fails CI with exit code 3. | complete |
| `screenshots upload\|download\|clear` | App Store: pixel-size → display type, validation (accepted sizes, no alpha, ≤ 10 per set), reservation → upload operations → MD5 commit → wait for `COMPLETE` → order; unchanged sets (same checksums) are skipped; `--append`. Play: `edits.images` (icon 512², feature graphic 1024×500, TV banner, phone/tablet/TV/Wear screenshots ≤ 8), compared by SHA-256. | complete (App previews/videos not yet) |
| `build upload` | iOS/macOS: App Store Connect **build upload API** (`buildUploads` + `buildUploadFiles`) — no Xcode, works on Linux; version and build number read from `Info.plist`; waits for processing. `--altool` uses `xcrun altool` with the same key. Android: resumable `edits.bundles.upload` (8 MiB chunks, resumes on 308), then track `--track` (default internal) and commit; `--no-track` only uploads. | complete |
| `release` | One command end to end. **App Store:** ensure version → metadata → screenshots → (upload `--ipa`) → wait for processing → export compliance → attach build → App Review contact + demo account (password from `SEARVIA_DEMO_PASSWORD`) → age rating → content rights → release type/date/copyright → phased release → submit via `reviewSubmissions`. **Play:** one edit with listings → images → bundle → track release (`--rollout %`, `--status`, release notes from `changelogs/`) → commit. Without a new build, `--rollout 50` / `--status halted` change the current staged rollout. Prints what must still be done by hand. | complete |
| `status` | App Store: last versions with state, build, release type, phased-release day; review submissions. Play: every track's releases, status and rollout %. | complete |
| `submit [--cancel]` | Submit the editable version for review, or withdraw the waiting submission (`reviewSubmissions` `canceled: true`). | complete (iOS; Play has no withdraw API) |
| `workflow run <file>` | Runs a YAML/JSON list of steps (see below). | complete |
| `login` / `logout` | Save or forget a Searvia API key. | complete |
| `projects` | Your Searvia projects. | complete |
| `keywords` | Tracked keywords with live rank, 1/7-day change, best rank, popularity, difficulty, opportunity. `--add a,b --yes` starts tracking. | complete |
| `research <term>` | Popularity (5–100 with source), difficulty, result count, top 10 and your rank; `--ideas` for App Store search-suggestion ideas. | complete |
| `popularity [terms]` | Popularity of given terms, or of all tracked keywords. | complete |
| `suggest` | AI metadata variants built from your tracked keywords (uses Searvia credits). `--use 2 --yes` writes variant 2 into your local files for `audit`/`push`. | complete |
| `mcp tools` / `mcp call <tool> --args '{…}'` | Any tool of the Searvia MCP server. | complete |
| `workspace` | A Claude Code workspace for a Searvia project (app or website): `CLAUDE.md` and `AGENTS.md` (how to work, approval before changes), `client.md`, `conversions.md`, `methods.md`, `workflow.md`, `wiki.md` (yours: written once, never overwritten), `log.md` (what Searvia proposed, applied and measured), `data/` (tracked keywords, Search Console queries and pages, latest site audit), `.mcp.json` and the matching skills in `.claude/skills`. Run it again to refresh. `--project`, `--dir`, `--no-skills`. | complete |

### The ASO audit

Same rules as Searvia's metadata audit, ported to run offline:

- **App Store:** keyword field in **UTF-8 bytes** (100; Turkish ç/ş/ğ/ı/ö/ü = 2 bytes, Chinese/Japanese/Korean = 3),
  title and subtitle 30 characters, the **160-character indexed pool** (title + subtitle + keywords), zero repetition
  across title/subtitle/keyword field and inside the field, filler words per language (Spanish *para* is filler,
  Turkish *para* is not), singular/plural twins, other companies' brands (`ios.avoid`), category and platform words,
  `a, b` comma spacing and phrases, empty slots, and **cross-locale overlap per storefront** (e.g. Turkey indexes both
  `tr` and `en-GB`, the US indexes ten localizations — words repeated across them are wasted). Promotional text (170),
  description and What's New (4000) limits.
- **Google Play:** title 30, short description 80, full description 4000, keyword density above 3 %, phrases repeated
  in the short description, repeated title words, untracked words repeated too often, keywords missing from the
  opening 300 characters.
- **Score:** 100 − 12 per error − 5 per warning (per affected word, up to three).
- **`--fix`:** drops words already in the title/subtitle, filler, category and brand words, repeats and plural
  twins, then packs the remaining words (your `--keywords` first) into 100 bytes.

### Workflows

```yaml
# .searvia/release.yml
name: Release
env:
  TRACK: production
steps:
  - run: audit --min-score 70
  - run: push
  - run: screenshots upload
  - name: iOS
    run: release --platform ios --ipa build/App.ipa
  - name: Android
    run: release --platform android --aab app/build/outputs/bundle/release/app-release.aab --track ${TRACK}
    with:
      rollout: 10
  - run: status
    continueOnError: true
```

```bash
searvia workflow run .searvia/release.yml          # every step as a dry run
searvia workflow run .searvia/release.yml --yes    # apply
```

Steps accept `name`, `run`, `with` (flags), `yes`, `continueOnError` and `if: ${VAR}` (skipped when empty or false).
`${VAR}` and `${VAR:-default}` come from the environment and `env:`. Any JSON file works too.

### CI (GitHub Actions)

```yaml
name: Ship
on:
  push:
    tags: ['v*']
jobs:
  ios:
    runs-on: ubuntu-latest   # uploading needs no Xcode; build the .ipa on macOS in a previous job
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: actions/download-artifact@v4
        with: { name: ipa, path: build }
      - run: npx searvia@latest audit --platform ios --min-score 70
      - run: npx searvia@latest release --platform ios --ipa build/App.ipa --yes --json
        env:
          ASC_BUNDLE_ID: com.example.budget
          ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}
          ASC_ISSUER_ID: ${{ secrets.ASC_ISSUER_ID }}
          ASC_PRIVATE_KEY: ${{ secrets.ASC_PRIVATE_KEY }}
          SEARVIA_DEMO_PASSWORD: ${{ secrets.DEMO_PASSWORD }}
  android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: ./gradlew bundleRelease
      - run: npx searvia@latest release --platform android --aab app/build/outputs/bundle/release/app-release.aab --rollout 10 --yes
        env:
          GOOGLE_PLAY_PACKAGE_NAME: com.example.budget
          GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: ${{ secrets.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON }}
```

Exit codes: `0` success, `1` error, `2` usage error, `3` audit below `--min-score`.

---

## What the store APIs cannot do

`release` prints these with the page to open. Do them once in the console:

| Store | Item | Where |
|---|---|---|
| App Store | **App Privacy** answers (privacy nutrition labels) — no API | `https://appstoreconnect.apple.com/apps/<appId>/distribution/privacy` |
| App Store | Creating the app record (there is no `POST /v1/apps`) | App Store Connect › Apps › + |
| App Store | Agreements, tax and banking | App Store Connect › Business |
| Google Play | Creating the app | Play Console › Create app |
| Google Play | App content declarations: Data safety, content rating questionnaire, target audience, ads, app access — no API | Play Console › your app › Policy and programs › App content |
| Google Play | First release of a brand-new app: Google expects it to be created in the console (fastlane has the same requirement) | Play Console › Testing › Internal testing |

Available through the APIs but not managed by this version yet: App Store pricing/availability, in-app purchases and
subscriptions, app previews (videos), custom product pages, Play in-app products. Note that Apple has marked the
screenshot set resources as superseded by the App Asset Library; they keep working and searvia will follow the new
resources when they become the only option.

## Security

- Credentials are read from env vars or local files and sent only to `api.appstoreconnect.apple.com`,
  `oauth2.googleapis.com` / `androidpublisher.googleapis.com` and, for Searvia commands, `searvia.com` (or
  `SEARVIA_URL`). No telemetry.
- `init` git-ignores `.searvia/` and key files it is told about; keep `.p8` and service-account JSON files out of
  the repository and use CI secrets.
- App Store Connect tokens live 19 minutes (Apple's maximum is 20); Google access tokens are cached in memory only.
- Pre-signed upload URLs are redacted from `--verbose` logs.
- The App Review demo password is read from an environment variable, never from the shared config.
- Dry run by default: nothing changes in a store without `--yes`.
- Report vulnerabilities privately through GitHub security advisories (Security › Report a vulnerability) on github.com/searvia/searvia-cli.

## Searvia

The optional `login`, `keywords`, `research`, `popularity`, `suggest`, `projects`, `mcp` and `workspace` commands talk to
[Searvia](https://searvia.com) — ASO and SEO with daily keyword rank tracking, Apple Ads popularity, review insights
and an AI metadata writer — over its MCP server (`https://searvia.com/mcp`, JSON-RPC over HTTP). The same server works
in Claude, ChatGPT and other MCP clients.

## Programmatic use

```ts
import { review, pack, auditApple, AppStoreConnect } from 'searvia';

review({ title: 'Cebbin: Budget', subtitle: 'Expense tracker', keywords: 'money,savings' }, { language: 'en' }).score;
```

## License

MIT © Searvia contributors
