# Searvia skills

Ready-made ASO workflows for AI coding agents and assistants: Claude Code, Claude (desktop and web), Codex, Cursor and
any client that reads `SKILL.md` folders. Each skill tells the agent which Searvia tools to call, in which order, what
to report and when to stop for the user's approval.

The same workflows are available as MCP prompts in the Searvia MCP server (type `/` in Claude, ChatGPT or Cursor), so
you can use them with or without installing anything.

| Skill | Workflow | What it does |
|---|---|---|
| [`aso-weekly-review`](./aso-weekly-review/SKILL.md) | Weekly ASO review | What moved this week for an app: rankings, competitors, store changes, reviews and the growth actions waiting for approval. |
| [`app-metadata-rewrite`](./app-metadata-rewrite/SKILL.md) | Rewrite store metadata | New title, subtitle and keyword field (or Google Play short and full description) built from tracked keywords, popularity and competitors. |
| [`app-keyword-gap`](./app-keyword-gap/SKILL.md) | Find keyword gaps | Keywords competitors rank for and this app does not, scored by popularity and difficulty, ready to track. |
| [`competitor-app-teardown`](./competitor-app-teardown/SKILL.md) | Competitor app teardown | Compare one competitor app with yours: keywords, listing, ratings, complaints, ads and estimated revenue. |
| [`app-review-replies`](./app-review-replies/SKILL.md) | Answer reviews in bulk | Group unanswered reviews by theme and draft on-brand replies for approval. |
| [`app-release-check`](./app-release-check/SKILL.md) | Pre-release check | Before submitting a version: build, metadata, screenshots, what is new text, review info and rating risks. |
| [`app-rank-drop`](./app-rank-drop/SKILL.md) | Investigate a ranking drop | Why one keyword fell: history, competitors on the same days, store changes, SERP volatility and notes. |
| [`app-localization-plan`](./app-localization-plan/SKILL.md) | Localization plan | Which countries to localize next, with keyword demand per country and the metadata to write. |
| [`app-screenshot-review`](./app-screenshot-review/SKILL.md) | Screenshot and creative review | What the first screenshots say, how competitors pitch, and a new caption set to test. |
| [`apple-ads-waste`](./apple-ads-waste/SKILL.md) | Apple Ads wasted spend | Search terms and keywords spending without installs, negatives to add and organic overlap. |
| [`ai-visibility-audit`](./ai-visibility-audit/SKILL.md) | AI visibility audit | How ChatGPT, Gemini, Perplexity and Claude answer about your brand: mention and citation rates, rivals they recommend, pages they cite and access problems. |
| [`app-market-opportunity`](./app-market-opportunity/SKILL.md) | Find an app market opportunity | Categories and new apps that grow fast, with revenue estimates and the complaints users have about the leaders. |

## Install

Copy the folders you want into your agent's skills directory:

| Client | Location |
|---|---|
| Claude Code | `~/.claude/skills/` (all projects) or `.claude/skills/` (one repository) |
| Codex | `~/.codex/skills/` |
| Cursor and other clients | the skills or rules folder of the client; each `SKILL.md` is plain Markdown with a name and a description |

```bash
git clone https://github.com/searvia/searvia-cli
cp -r searvia-cli/skills/* ~/.claude/skills/
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
