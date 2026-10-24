import { join } from 'node:path';
import { androidMetadataDir, metadataDir } from '../core/config.js';
import { changed, type FieldChange, normalise, renderChanges } from '../core/diff.js';
import { CliError, UsageError } from '../core/errors.js';
import { askSecret, interactive } from '../core/prompt.js';
import { isRecord } from '../core/util.js';
import { readText, writeText } from '../metadata/files.js';
import { DEFAULT_URL, deleteCredentials, readCredentials, SearviaClient, saveCredentials } from '../searvia/mcp.js';
import { type Command, type Context, dryRunNote, list } from './context.js';

export const SIGNUP_NOTE =
  'This command uses your Searvia account (keyword rankings, popularity, AI metadata). Create a free account at https://searvia.com, make an API key under Settings › API and MCP (https://searvia.com/settings/api), then run `searvia login`.';

function baseUrl(context: Context, stored?: string): string {
  return context.env.SEARVIA_URL || stored || context.loaded.config.searvia?.url || DEFAULT_URL;
}

export function searviaClient(context: Context): SearviaClient {
  const credentials = readCredentials(context.env);
  if (!credentials) throw new CliError('Not logged in to Searvia.', { hint: SIGNUP_NOTE });
  return new SearviaClient(credentials.apiKey, baseUrl(context, credentials.url), context.out);
}

interface Project {
  id: number;
  type: string;
  name: string;
  store?: string | null;
  store_app_id?: string | null;
  domain?: string | null;
  country?: string;
  language?: string;
  tracked_keywords?: number;
}

/** --project, else searvia.projectId, else the project whose store id matches ios.appId / bundle / android.packageName. */
export async function resolveProject(client: SearviaClient, context: Context): Promise<Project> {
  const projects = await client.callTool<Project[]>('list_projects');
  const wanted = (context.options.project as number | undefined) ?? context.loaded.config.searvia?.projectId;
  if (wanted !== undefined) {
    const project = projects.find((item) => item.id === Number(wanted));
    if (!project) throw new CliError(`Searvia project ${wanted} not found.`, { hint: 'Run `searvia projects` to list them.' });
    return project;
  }
  const ids = [context.loaded.config.ios?.appId, context.loaded.config.ios?.bundleId, context.loaded.config.android?.packageName].filter(Boolean).map(String);
  const platform = String(context.options.platform ?? '');
  const apps = projects.filter((item) => item.type !== 'website' && item.store_app_id);
  const matches = apps.filter((item) => ids.includes(String(item.store_app_id)) && (!platform || (platform === 'ios') === (item.store === 'apple')));
  const chosen = matches[0] ?? (apps.length === 1 ? apps[0] : undefined);
  if (!chosen) {
    throw new CliError(projects.length ? 'Which Searvia project? Several apps are tracked.' : 'This Searvia account has no app projects yet.', {
      hint: projects.length
        ? `Pass --project <id> or set searvia.projectId: ${apps.map((item) => `${item.id} ${item.name} (${item.store})`).join(', ')}`
        : 'Add your app at https://searvia.com/app.',
    });
  }
  return chosen;
}

const PROJECT_OPTION = { name: 'project', type: 'number' as const, value: '<id>', description: 'Searvia project id (default: matched from your config).' };

export const login: Command = {
  name: 'login',
  summary: 'Save a Searvia API key on this machine',
  usage: 'searvia login [--key <api-key>]',
  description: 'Stores the key in your user config folder (~/.config/searvia/credentials.json, mode 600), never in the project. CI can use SEARVIA_API_KEY instead.',
  options: [
    { name: 'key', type: 'string', value: '<api-key>', description: 'The API key (otherwise prompted, hidden). Prefer the prompt or stdin to keep it out of shell history.' },
  ],
  async run(context) {
    let key = (context.options.key as string | undefined) ?? context.env.SEARVIA_API_KEY;
    if (!key && !process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      key = Buffer.concat(chunks).toString('utf8').trim();
    }
    if (!key && interactive()) {
      context.out.log('Create a key at https://searvia.com/settings/api (free account: https://searvia.com).');
      key = await askSecret('Searvia API key');
    }
    if (!key) throw new UsageError('No API key given.', 'Pass --key, pipe it on stdin, or run in a terminal.');
    const url = baseUrl(context);
    const client = new SearviaClient(key, url, context.out);
    const tools = await client.listTools();
    const projects = await client.callTool<Project[]>('list_projects').catch(() => [] as Project[]);
    const path = saveCredentials({ apiKey: key, url: url === DEFAULT_URL ? undefined : url }, context.env);
    context.out.success(`Logged in to ${url} (${tools.length} tools, ${projects.length} projects). Key saved to ${path}.`);
    return { url, tools: tools.length, projects: projects.map((item) => ({ id: item.id, name: item.name, store: item.store })) };
  },
};

export const logout: Command = {
  name: 'logout',
  summary: 'Forget the saved Searvia API key',
  usage: 'searvia logout',
  options: [],
  async run(context) {
    const removed = deleteCredentials(context.env);
    context.out.log(removed ? 'Removed the saved Searvia key.' : 'No saved Searvia key.');
    if (context.env.SEARVIA_API_KEY) context.out.warn('SEARVIA_API_KEY is still set in the environment.');
    return { removed };
  },
};

export const projects: Command = {
  name: 'projects',
  summary: 'List your Searvia projects',
  usage: 'searvia projects',
  options: [],
  async run(context) {
    const rows = await searviaClient(context).callTool<Project[]>('list_projects');
    context.out.table(rows as unknown as Array<Record<string, unknown>>, ['id', 'name', 'store', 'store_app_id', 'country', 'tracked_keywords']);
    return { projects: rows };
  },
};

interface KeywordRow {
  keyword: string;
  country: string;
  rank: number | null;
  change_1d: number | null;
  change_7d: number | null;
  best: number | null;
  difficulty: number | null;
  popularity: { score: number; low?: number; high?: number; source?: string } | null;
  opportunity: number | null;
  golden?: boolean;
}

export const keywords: Command = {
  name: 'keywords',
  summary: 'Tracked keywords with live ranks, popularity and difficulty (Searvia)',
  usage: 'searvia keywords [--project <id>] [--days 30] [--add word,word --yes]',
  options: [
    PROJECT_OPTION,
    { name: 'platform', alias: 'p', type: 'string', value: '<ios|android>', description: 'Pick the project of this store.' },
    { name: 'days', type: 'number', value: '<n>', default: 30, description: 'Days of history (1–90).' },
    { name: 'add', type: 'list', value: '<keywords>', description: 'Start tracking these keywords (uses plan quota; needs --yes).' },
    { name: 'country', type: 'string', value: '<CC>', description: 'Country for --add (default: the project country).' },
  ],
  async run(context) {
    const client = searviaClient(context);
    const project = await resolveProject(client, context);
    const add = list(context.options.add);
    if (add) {
      if (!context.apply) {
        context.out.log(`Would start tracking ${add.length} keywords in ${project.name}: ${add.join(', ')}`);
        dryRunNote(context);
        return { project, planned: add };
      }
      const message = await client.callTool('add_keywords', { project_id: project.id, keywords: add, ...(context.options.country ? { country: context.options.country } : {}) });
      context.out.success(String(message));
      return { project, added: add };
    }
    const data = await client.callTool<{ project: string; keywords: KeywordRow[] }>('get_keyword_rankings', { project_id: project.id, days: context.options.days });
    const rows = data.keywords.map((row) => ({
      keyword: row.keyword,
      country: row.country,
      rank: row.rank ?? '>depth',
      '1d': row.change_1d,
      '7d': row.change_7d,
      best: row.best,
      popularity: row.popularity?.score,
      difficulty: row.difficulty,
      opportunity: row.opportunity,
      golden: row.golden ? '★' : '',
    }));
    context.out.log(context.out.paint('bold', `${data.project} · ${rows.length} keywords`));
    context.out.table(rows, ['keyword', 'country', 'rank', '1d', '7d', 'best', 'popularity', 'difficulty', 'opportunity', 'golden']);
    return data;
  },
};

export const research: Command = {
  name: 'research',
  summary: 'Research a keyword: popularity, difficulty, top 10 (Searvia)',
  usage: 'searvia research <term> [--country US] [--store apple|google] [--ideas]',
  options: [
    PROJECT_OPTION,
    { name: 'country', type: 'string', value: '<CC>', description: 'Two-letter country (default: project country, else US).' },
    { name: 'store', type: 'string', value: '<apple|google>', description: 'Store (default: project store, else apple).' },
    { name: 'ideas', type: 'boolean', description: 'Keyword ideas from App Store search suggestions instead.' },
    { name: 'limit', type: 'number', value: '<n>', description: 'Max ideas (default 30).' },
  ],
  async run(context) {
    const term = context.positionals.join(' ').trim();
    if (!term) throw new UsageError('Which term? `searvia research "habit tracker"`');
    const client = searviaClient(context);
    const project = context.options.project !== undefined || context.loaded.config.searvia?.projectId ? await resolveProject(client, context) : undefined;
    const base = { ...(project ? { project_id: project.id } : {}), ...(context.options.country ? { country: context.options.country } : {}) };

    if (context.options.ideas) {
      if (!(await client.hasTool('suggest_keywords'))) throw new CliError('This Searvia server has no keyword ideas tool yet.');
      const data = await client.callTool<{ seed: string; country: string; suggestions: Array<Record<string, unknown>> }>('suggest_keywords', {
        seed: term,
        limit: context.options.limit ?? 30,
        ...base,
      });
      context.out.log(context.out.paint('bold', `Ideas for “${data.seed}” (${data.country})`));
      context.out.table(data.suggestions, ['keyword', 'suggestion_rank', 'apple_popularity', 'tracked'], ['keyword', 'prominence', 'popularity', 'tracked']);
      return data;
    }

    if (await client.hasTool('research_keyword')) {
      const data = await client.callTool<Record<string, unknown>>('research_keyword', {
        keyword: term,
        ...(context.options.store ? { store: context.options.store } : {}),
        ...base,
      });
      const popularity = data.popularity as { score?: number; low?: number; high?: number; source?: string } | null;
      const difficulty = data.difficulty as { score?: number; tier?: string } | null;
      context.out.log(context.out.paint('bold', `“${data.keyword}” · ${data.store} ${data.country}`));
      context.out.log(`  popularity  ${popularity?.score ?? '–'}${popularity?.low !== undefined ? ` (${popularity.low}–${popularity.high}, ${popularity.source})` : ''}`);
      context.out.log(`  difficulty  ${difficulty?.score ?? '–'}${difficulty?.tier ? ` (${difficulty.tier})` : ''}`);
      context.out.log(`  results     ${data.results ?? '–'}`);
      if (isRecord(data.project)) context.out.log(`  your rank   ${data.project.rank ?? 'not in top 200'}`);
      context.out.log();
      context.out.table((data.top as Array<Record<string, unknown>>) ?? [], ['rank', 'title', 'developer', 'rating', 'reviews', 'id']);
      return data;
    }

    // Older servers: public App Store search (not the live ranking order).
    const apps = await client.callTool<Array<Record<string, unknown>>>('search_app_store', { query: term, country: context.options.country ?? 'US' });
    context.out.table(apps, ['title', 'developer', 'rating', 'ratings_count', 'category', 'app_id']);
    return { keyword: term, apps };
  },
};

export const popularity: Command = {
  name: 'popularity',
  summary: 'Search popularity (5–100) of keywords (Searvia)',
  usage: 'searvia popularity [term ...] [--country US]',
  description:
    'With terms: researches each one (free, live). Without: popularity of every tracked keyword of the project. Source apple_ads = Apple’s own score from a connected Apple Ads account; estimate = Searvia’s model with a range.',
  options: [
    PROJECT_OPTION,
    { name: 'country', type: 'string', value: '<CC>', description: 'Two-letter country.' },
    { name: 'store', type: 'string', value: '<apple|google>', description: 'Store.' },
  ],
  async run(context) {
    const client = searviaClient(context);
    const terms = context.positionals
      .flatMap((term) => term.split(','))
      .map((term) => term.trim())
      .filter(Boolean);
    if (terms.length) {
      const rows: Array<Record<string, unknown>> = [];
      for (const term of terms) {
        const data = await client.callTool<Record<string, unknown>>('research_keyword', {
          keyword: term,
          ...(context.options.country ? { country: context.options.country } : {}),
          ...(context.options.store ? { store: context.options.store } : {}),
        });
        const score = data.popularity as { score?: number; low?: number; high?: number; source?: string } | null;
        rows.push({
          keyword: term,
          country: data.country,
          popularity: score?.score,
          range: score?.low !== undefined ? `${score.low}–${score.high}` : undefined,
          source: score?.source,
          difficulty: (data.difficulty as { score?: number } | null)?.score,
        });
      }
      context.out.table(rows, ['keyword', 'country', 'popularity', 'range', 'source', 'difficulty']);
      return { keywords: rows };
    }
    const project = await resolveProject(client, context);
    const data = await client.callTool<{ project: string; keywords: KeywordRow[] }>('get_keyword_rankings', { project_id: project.id, days: 1 });
    const rows = data.keywords
      .map((row) => ({
        keyword: row.keyword,
        country: row.country,
        popularity: row.popularity?.score,
        range: row.popularity?.low !== undefined ? `${row.popularity.low}–${row.popularity.high}` : undefined,
        source: row.popularity?.source,
        rank: row.rank,
      }))
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
    context.out.table(rows, ['keyword', 'country', 'popularity', 'range', 'source', 'rank']);
    return { project: data.project, keywords: rows };
  },
};

const VARIANT_FILES: Record<string, { apple?: string; google?: string }> = {
  title: { apple: 'name', google: 'title' },
  subtitle: { apple: 'subtitle' },
  keywords: { apple: 'keywords' },
  short_description: { google: 'short_description' },
};

export const suggest: Command = {
  name: 'suggest',
  summary: 'AI metadata variants from your tracked keywords (Searvia, uses credits)',
  usage: 'searvia suggest [--project <id>] [--locale en-GB] [--use 1 --yes]',
  description:
    'Asks Searvia’s metadata writer for title/subtitle/keyword-field variants (App Store) or title/short description (Google Play), built from your tracked keywords, popularity and competitors. Nothing is published. --use <n> writes variant n into your local metadata files (dry-run diff unless --yes); review and `searvia push` it.',
  options: [
    PROJECT_OPTION,
    { name: 'platform', alias: 'p', type: 'string', value: '<ios|android>', description: 'Pick the project of this store.' },
    { name: 'locale', alias: 'l', type: 'string', value: '<code>', description: 'App Store: another localization indexed in the project country (e.g. en-GB in Turkey).' },
    { name: 'use', type: 'number', value: '<n>', description: 'Write variant n (1-based) to the local metadata folder.' },
  ],
  async run(context) {
    const client = searviaClient(context);
    const project = await resolveProject(client, context);
    context.out.step(`Writing metadata variants for ${project.name} (uses Searvia credits)…`);
    const data = await client.callTool<{ variants: Array<Record<string, unknown>>; notes?: string; locale?: string | null; language?: string; limits?: Record<string, number> }>(
      'write_metadata_suggestion',
      {
        project_id: project.id,
        ...(context.options.locale ? { locale: context.options.locale } : {}),
      },
    );
    data.variants.forEach((variant, index) => {
      context.out.log(context.out.paint('bold', `\nVariant ${index + 1}${variant.score !== undefined ? ` · score ${variant.score}` : ''}`));
      for (const field of Object.keys(VARIANT_FILES)) if (typeof variant[field] === 'string') context.out.log(`  ${field.padEnd(18)} ${variant[field]}`);
      if (typeof variant.rationale === 'string') context.out.log(context.out.paint('gray', `  ${variant.rationale}`));
    });
    if (data.notes) context.out.log(context.out.paint('gray', `\n${data.notes}`));

    const use = context.options.use as number | undefined;
    if (use === undefined) return { project, ...data };
    const variant = data.variants[use - 1];
    if (!variant) throw new UsageError(`There is no variant ${use}.`);
    const store = project.store === 'google' ? 'google' : 'apple';
    const locale = (context.options.locale as string | undefined) ?? data.locale ?? (store === 'apple' ? undefined : undefined);
    if (!locale) throw new UsageError('Pass --locale to say which metadata folder to write (e.g. --locale en-US).');
    const dir = store === 'apple' ? metadataDir(context.loaded) : androidMetadataDir(context.loaded);
    const changes: FieldChange[] = [];
    for (const [field, files] of Object.entries(VARIANT_FILES)) {
      const file = files[store];
      if (!file || typeof variant[field] !== 'string') continue;
      const path = join(dir, locale, `${file}.txt`);
      const before = readText(path);
      if (changed(before, variant[field] as string))
        changes.push({ platform: store === 'apple' ? 'ios' : 'android', locale, field: file, before: normalise(before), after: normalise(variant[field] as string) });
    }
    renderChanges(context.out, changes);
    if (context.apply) {
      for (const change of changes) writeText(join(dir, locale, `${change.field}.txt`), change.after);
      context.out.success(`Wrote variant ${use} to ${join(dir, locale)}. Check it with \`searvia audit\`, then \`searvia push\`.`);
    } else dryRunNote(context, 'The files were not changed');
    return { project, ...data, written: context.apply ? changes : [] };
  },
};

export const mcp: Command = {
  name: 'mcp',
  summary: 'Call any Searvia MCP tool (tools, call <name> --args JSON)',
  usage: 'searvia mcp tools | searvia mcp call <tool> [--args \'{"project_id":1}\']',
  options: [{ name: 'args', type: 'string', value: '<json>', description: 'Tool arguments as a JSON object.' }],
  async run(context) {
    const [action, name] = context.positionals;
    const client = searviaClient(context);
    if (action === 'tools') {
      const tools = await client.listTools();
      for (const tool of tools) context.out.log(`${context.out.paint('bold', tool.name.padEnd(32))} ${(tool.description ?? '').split('. ')[0]}`);
      return { tools };
    }
    if (action === 'call' && name) {
      let args: unknown = {};
      try {
        args = JSON.parse(String(context.options.args ?? '{}'));
      } catch {
        throw new UsageError('--args must be a JSON object.');
      }
      if (!isRecord(args)) throw new UsageError('--args must be a JSON object.');
      const result = await client.callTool(name, args);
      if (!context.out.json) context.out.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      return result;
    }
    throw new UsageError('Use `searvia mcp tools` or `searvia mcp call <tool> --args <json>`.');
  },
};
