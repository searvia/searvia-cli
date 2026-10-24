import { existsSync } from 'node:fs';
import { resolveApp } from '../apple/app.js';
import { androidMetadataDir, hasAndroid, hasIos, metadataDir, screenshotsDir } from '../core/config.js';
import { DEFAULT_URL, readCredentials, SearviaClient } from '../searvia/mcp.js';
import { VERSION } from '../version.js';
import { appStore, type Command, googlePlay } from './context.js';

interface Check {
  check: string;
  ok: boolean;
  detail: string;
}

export const doctor: Command = {
  name: 'doctor',
  summary: 'Check config, folders and that each key works (read-only)',
  usage: 'searvia doctor',
  options: [],
  async run(context) {
    const checks: Check[] = [];
    const add = (check: string, ok: boolean, detail: string) => {
      checks.push({ check, ok, detail });
      context.out.log(`${ok ? context.out.paint('green', '✓') : context.out.paint('red', '✗')} ${check.padEnd(22)} ${detail}`);
    };
    const attempt = async (check: string, work: () => Promise<string>) => {
      try {
        add(check, true, await work());
      } catch (error) {
        add(check, false, `${(error as Error).message}${(error as { hint?: string }).hint ? ` (${(error as { hint?: string }).hint})` : ''}`);
      }
    };

    add('searvia', true, `v${VERSION}, Node ${process.versions.node}`);
    add('config', context.loaded.files.length > 0, context.loaded.files.join(', ') || 'none (run `searvia init`)');
    for (const [label, dir] of [
      ['metadata', metadataDir(context.loaded)],
      ['android metadata', androidMetadataDir(context.loaded)],
      ['screenshots', screenshotsDir(context.loaded)],
    ] as const) {
      add(label, existsSync(dir), dir);
    }
    if (hasIos(context.loaded)) {
      await attempt('App Store Connect', async () => {
        const app = await resolveApp(appStore(context), context.loaded.config.ios ?? {});
        return `${app.name} (${app.bundleId}, ${app.id})`;
      });
    }
    if (hasAndroid(context.loaded)) {
      await attempt('Google Play', async () => {
        const play = googlePlay(context);
        const listings = await play.withEdit((editId) => play.listings(editId), { commit: false });
        return `${play.packageName}, ${listings.length} store listings`;
      });
    }
    const credentials = readCredentials(context.env);
    if (credentials) {
      await attempt('Searvia', async () => {
        const client = new SearviaClient(credentials.apiKey, context.env.SEARVIA_URL || credentials.url || DEFAULT_URL, context.out);
        return `${(await client.listTools()).length} MCP tools`;
      });
    } else add('Searvia', true, 'not logged in (optional: `searvia login`)');
    return { ok: checks.every((item) => item.ok || item.check.includes('metadata') || item.check === 'screenshots'), checks };
  },
};
