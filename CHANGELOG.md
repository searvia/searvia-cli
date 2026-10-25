# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-10-25

### Changed

- Releases publish to npm from GitHub Actions with trusted publishing; the workflow skips versions already on npm.

### Added

- `skills/`: 12 ASO workflow skills (weekly review, metadata rewrite, keyword gap, competitor teardown, review
  replies, release check, rank drop, localization, screenshots, Apple Ads waste, AI visibility, market opportunity)
  for Claude Code, Codex, Cursor and other `SKILL.md` clients. They call the Searvia MCP server or fall back to
  `searvia mcp call`.

## [0.1.0] - 2026-10-24

### Added

- `init`, `doctor`: config files (`searvia.config.json` + git-ignored `.searvia/config.json`), detection of fastlane
  folders, `Appfile`, Gradle `applicationId` and `AuthKey_*.p8`.
- `pull` / `push`: App Store Connect (all localizations: name, subtitle, keywords, description, promotional text,
  What's New, URLs, copyright) and Google Play (title, short/full description, video, release notes) in fastlane
  deliver/supply layout, field-level diffs, `--create-locales`, `--create-version`.
- `audit`: offline ASO audit ported from Searvia's rule engine (UTF-8 byte keyword field, 160-character pool,
  repetition, filler per language, plurals, brands, category words, format, cross-locale overlap per storefront, Play
  density), `--fix` keyword packing, `--min-score` for CI.
- `screenshots upload|download|clear`: App Store screenshot sets (size detection and validation, reservation →
  upload operations → MD5 commit, checksum skip) and Google Play images.
- `build upload`: App Store Connect build upload API (`buildUploads`/`buildUploadFiles`), `--altool` fallback; Android
  App Bundles with resumable uploads.
- `release`, `status`, `submit [--cancel]`: end-to-end App Store submission through `reviewSubmissions` and Google Play
  edits with staged rollouts.
- `workflow run`: YAML/JSON step files for CI.
- Searvia connection over MCP: `login`, `logout`, `projects`, `keywords`, `research`, `popularity`, `suggest`, `mcp`.
- `--json` output and dry-run-by-default writes on every command.

### Known limitations

- App previews (videos), pricing/availability, in-app purchases and custom product pages are not managed yet.
- Apple marks the screenshot set resources as superseded by the App Asset Library; they still work today.
