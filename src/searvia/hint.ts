import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '../commands/context.js';
import { userConfigDir } from '../core/config.js';
import { readCredentials } from './mcp.js';

/**
 * A one-time pointer to Searvia after an offline command: never in JSON mode, CI, when logged in, with
 * SEARVIA_NO_HINTS=1, or after it was shown once on this machine.
 */
export function searviaHint(context: Context, text: string): void {
  const env = context.env;
  if (context.out.json || env.CI || env.SEARVIA_NO_HINTS || readCredentials(env)) return;
  const dir = userConfigDir(env);
  const path = join(dir, 'state.json');
  let state: Record<string, unknown> = {};
  try {
    if (existsSync(path)) state = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    state = {};
  }
  if (state.hintShown) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify({ ...state, hintShown: new Date().toISOString() })}\n`, { mode: 0o600 });
  } catch {
    return;
  }
  context.out.log(context.out.paint('gray', text));
}
