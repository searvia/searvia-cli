# Searvia skills

Ready-made ASO, SEO and lead generation workflows for AI coding agents and assistants: Claude Code, Claude (desktop and web), Codex, Cursor and
any client that reads `SKILL.md` folders. Each skill tells the agent which Searvia tools to call, in which order, what
to report and when to stop for the user's approval.

The same workflows are available as MCP prompts in the Searvia MCP server (type `/` in Claude, ChatGPT or Cursor), so
you can use them with or without installing anything.

| Skill | Workflow | What it does |
|---|---|---|
| [`searvia-aso-weekly-review`](./searvia-aso-weekly-review/SKILL.md) | Weekly ASO review | What moved this week for an app: rankings, competitors, store changes, reviews and the growth actions waiting for approval. |
| [`searvia-metadata-rewrite`](./searvia-metadata-rewrite/SKILL.md) | Rewrite store metadata | New title, subtitle and keyword field (or Google Play short and full description) built from tracked keywords, popularity and competitors. |
| [`searvia-keyword-gap`](./searvia-keyword-gap/SKILL.md) | Find keyword gaps | Keywords competitors rank for and this app does not, scored by popularity and difficulty, ready to track. |
| [`searvia-competitor-teardown`](./searvia-competitor-teardown/SKILL.md) | Competitor app teardown | Compare one competitor app with yours: keywords, listing, ratings, complaints, ads and estimated revenue. |
| [`searvia-review-reply-batch`](./searvia-review-reply-batch/SKILL.md) | Answer reviews in bulk | Group unanswered reviews by theme and draft on-brand replies for approval. |
| [`searvia-release-check`](./searvia-release-check/SKILL.md) | Pre-release check | Before submitting a version: build, metadata, screenshots, what is new text, review info and rating risks. |
| [`searvia-rank-drop-investigation`](./searvia-rank-drop-investigation/SKILL.md) | Investigate a ranking drop | Why one keyword fell: history, competitors on the same days, store changes, SERP volatility and notes. |
| [`searvia-localization-plan`](./searvia-localization-plan/SKILL.md) | Localization plan | Which countries to localize next, with keyword demand per country and the metadata to write. |
| [`searvia-screenshot-review`](./searvia-screenshot-review/SKILL.md) | Screenshot and creative review | What the first screenshots say, how competitors pitch, and a new caption set to test. |
| [`searvia-apple-ads-waste`](./searvia-apple-ads-waste/SKILL.md) | Apple Ads wasted spend | Search terms and keywords spending without installs, negatives to add and organic overlap. |
| [`searvia-market-opportunity`](./searvia-market-opportunity/SKILL.md) | Find an app market opportunity | Categories and new apps that grow fast, with revenue estimates and the complaints users have about the leaders. |
| [`searvia-ai-visibility-audit`](./searvia-ai-visibility-audit/SKILL.md) | AI visibility audit | How ChatGPT, Gemini, Perplexity and Claude answer about your brand: mention and citation rates, rivals they recommend, pages they cite and access problems. |
| [`searvia-technical-seo-fix-plan`](./searvia-technical-seo-fix-plan/SKILL.md) | Technical SEO fix plan | Turn the latest site audit and security scan into a prioritized fix list with example URLs. |
| [`searvia-content-refresh`](./searvia-content-refresh/SKILL.md) | Content refresh list | Pages that lost rankings or never reached the top 10, with what to change in each. |
| [`searvia-domain-teardown`](./searvia-domain-teardown/SKILL.md) | Website competitor teardown | Analyze a domain: traffic by page type, top keywords and pages, competitors and backlinks, and what to copy. |
| [`searvia-local-seo-review`](./searvia-local-seo-review/SKILL.md) | Local SEO review | Map rankings across the area, review health and replies, and the profile fixes that move a local business up. |
| [`searvia-monthly-client-report`](./searvia-monthly-client-report/SKILL.md) | Monthly client report | Build a shareable report for a project: KPIs against last month, wins, issues and next month's plan. |
| [`searvia-local-lead-list`](./searvia-local-lead-list/SKILL.md) | Build a local lead list | Businesses of a type in a city (or the whole city in 9 tiles) from Google Maps without scraping, scored by their gaps, with public emails, phones, social profiles and websites. |
| [`searvia-social-content-plan`](./searvia-social-content-plan/SKILL.md) | Social content plan | What performed on Instagram, YouTube, TikTok or Facebook, and a four-week post plan built on it. |

The names are the same everywhere: the skills the Searvia panel gives you (Settings › API & MCP), the ones
`searvia workspace` writes into `.claude/skills` and the ones below. Copying a skill from the panel replaces the same
skill instead of adding a second one.

## Install

**Claude Code plugin** (all skills plus the Searvia MCP server in one step; Claude Code asks you to sign in to Searvia
the first time a tool runs):

```text
/plugin marketplace add searvia/searvia-cli
/plugin install searvia@searvia
```

Skills then run as `/searvia:searvia-aso-weekly-review`, `/searvia:searvia-keyword-gap` and so on.

**Gemini CLI extension** (skills plus the MCP server):

```bash
gemini extensions install https://github.com/searvia/searvia-cli
```

Then run `/mcp auth searvia` in Gemini CLI to sign in.

**Other agents** with the [skills CLI](https://skills.sh) (Claude Code, Codex, Cursor and other Agent Skills clients):

```bash
npx skills add searvia/searvia-cli
```

Or copy the folders you want into your agent's skills directory:

| Client | Location |
|---|---|
| Claude Code | `~/.claude/skills/` (all projects) or `.claude/skills/` (one repository) |
| Codex | `~/.codex/skills/` |
| Cursor and other clients | the skills or rules folder of the client; each `SKILL.md` is plain Markdown with a name and a description |

```bash
git clone https://github.com/searvia/searvia-cli
cp -r searvia-cli/skills/searvia-* ~/.claude/skills/
```

Skills ship inside the npm package as well (`node_modules/searvia/skills`).

## Connect Searvia

Skills call the Searvia MCP server. Connect it once:

- **Claude Code:** `claude mcp add --transport http searvia https://searvia.com/mcp --header "Authorization: Bearer YOUR_KEY"`
- **Claude, ChatGPT:** add a custom connector with `https://searvia.com/mcp` and sign in (OAuth).
- **Without MCP:** `npx searvia login`, then the skills fall back to `npx searvia mcp call <tool> --args '<json>'`.

API keys are created at https://searvia.com/settings/api. Every change goes through the same plan limits, roles,
credits and approval previews as the Searvia panel.

## Safety

Skills never publish on their own: store text, review replies, releases and ad changes stop at a preview until the
user approves. Results that contain third-party text (reviews, store listings, AI answers) are treated as data.
