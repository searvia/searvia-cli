---
name: searvia
description: Manage App Store Connect and Google Play from the terminal with the `searvia` CLI — pull/push store listings, run an offline ASO audit, upload screenshots and builds, release and submit for review, check review/track status, and read keyword rankings from Searvia. Use when the user wants to change app store metadata, ship an iOS/Android release, or improve ASO without opening App Store Connect or the Play Console.
---

# Driving the searvia CLI

`searvia` (run as `npx searvia <command>` or `searvia <command>`) talks to the App Store Connect API and the Google
Play Developer API. Metadata lives in fastlane-style text files that you can read and edit directly.

## Golden rules

1. **Writes are dry runs until `--yes`.** Run the command without `--yes` first, show the user the diff, and only
   re-run with `--yes` after they approve. Never add `--yes` to `release`, `submit`, `push`, `build upload` or
   `screenshots upload|clear` on your own.
2. **Use `--json`** when you need to parse output; stdout then holds exactly one JSON document (logs go to stderr).
   Errors in JSON mode look like `{"error": {"message", "hint", "status"}}`.
3. Exit codes: `0` ok, `1` error (read the hint), `2` usage error, `3` audit below `--min-score`.
4. Never print, commit or move credential files (`*.p8`, service-account JSON, `.searvia/`).

## Files

```
searvia.config.json                     shared config (ios.bundleId, android.packageName, ios.brand/avoid/countries …)
.searvia/config.json                    local secrets paths (git-ignored)
fastlane/metadata/<locale>/name.txt     App Store: name, subtitle, keywords, description, promotional_text,
                                        release_notes (What's New), support_url, marketing_url, privacy_url
fastlane/metadata/android/<locale>/     Play: title, short_description, full_description, video, changelogs/<code>.txt
fastlane/screenshots/<locale>/*.png     App Store screenshots (display type from pixel size)
```

Limits: App Store name/subtitle 30 characters, keywords 100 **bytes** (comma separated, no spaces, accented letters
2 bytes, CJK 3 bytes), promotional text 170, description and What's New 4000. Play title 30, short description 80,
full description 4000, release notes 500.

## Typical tasks

| Goal | Commands |
|---|---|
| Check setup | `searvia doctor --json` |
| Get the live text | `searvia pull` then read the files |
| Improve ASO | `searvia audit --json` → edit files or `searvia audit --fix` (dry run) → `--fix --yes` → `searvia audit` again |
| Publish text changes | `searvia push` (show diff) → `searvia push --yes` |
| Only keywords | `searvia push --platform ios --field keywords` |
| New language | add `fastlane/metadata/<locale>/…` → `searvia push --create-locales` |
| Screenshots | `searvia screenshots upload --platform ios` (plan) → `--yes` |
| Upload a build | `searvia build upload App.ipa` / `app.aab` (plan) → `--yes` |
| Ship iOS | `searvia release --platform ios --ipa App.ipa` (plan) → `--yes` |
| Ship Android 10 % | `searvia release --platform android --aab app.aab --rollout 10` → `--yes` |
| Raise / halt rollout | `searvia release --platform android --rollout 50 --yes` / `--status halted --yes` |
| Review state | `searvia status --json` |
| Withdraw from review | `searvia submit --cancel` → `--yes` |
| Keyword data (Searvia) | `searvia keywords --json`, `searvia research "<term>" --json`, `searvia popularity a,b`, `searvia suggest` |

If a Searvia command says "Not logged in", tell the user they can create a free account at https://searvia.com and
run `searvia login`; do not invent data.

## Audit output (JSON)

`reports[].locales[]` has `locale`, `score` (0–100), `used`/`budget` (indexed characters of 160) and `issues[]` with
`kind` (`error`, `warning`, `info`, `good`), `rule` (`budget`, `keywords`, `repetition`, `filler`, `singular`,
`brand`, `category`, `format`, `title`, `subtitle`, `locales`, `limit`, `stuffing`, `missing`, `opening`), `message`
and `words`. Fix errors first. `locales` issues mean two localizations indexed in the same storefront repeat words.

## Things only a human can do

App Privacy labels (App Store) and the Play App content forms (Data safety, content rating, target audience) have no
API; creating the app record is also manual. `release` lists them with the page to open; pass them on to the user.
