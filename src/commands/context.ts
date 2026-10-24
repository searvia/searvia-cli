import { AppStoreConnect } from '../apple/client.js';
import type { OptionSpec } from '../core/args.js';
import { ascCredentials, hasAndroid, hasIos, type LoadedConfig, playCredentials } from '../core/config.js';
import { CliError, UsageError } from '../core/errors.js';
import type { Output } from '../core/output.js';
import { GooglePlay } from '../play/client.js';

export interface Context {
  out: Output;
  loaded: LoadedConfig;
  options: Record<string, unknown>;
  positionals: string[];
  /** --yes: apply writes (otherwise dry run). */
  apply: boolean;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Runs another CLI command line in-process (used by workflows). */
  run: (argv: string[]) => Promise<number>;
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  description?: string;
  options: OptionSpec[];
  examples?: string[];
  run(context: Context): Promise<unknown>;
}

export type Platform = 'ios' | 'android';

export const PLATFORM_OPTION: OptionSpec = {
  name: 'platform',
  alias: 'p',
  type: 'string',
  value: '<ios|android|all>',
  description: 'Store to work on (default: every store configured).',
};

/** Platforms for a command: --platform, else every configured store. */
export function platforms(context: Context): Platform[] {
  const flag = String(context.options.platform ?? 'all').toLowerCase();
  if (flag === 'ios' || flag === 'appstore' || flag === 'apple') return ['ios'];
  if (flag === 'android' || flag === 'play' || flag === 'google') return ['android'];
  if (flag !== 'all') throw new UsageError(`Unknown platform "${flag}" (use ios, android or all).`);
  const configured: Platform[] = [];
  if (hasIos(context.loaded)) configured.push('ios');
  if (hasAndroid(context.loaded)) configured.push('android');
  if (configured.length === 0) {
    throw new CliError('No store is configured.', { hint: 'Run `searvia init`, or set ASC_* / GOOGLE_PLAY_* environment variables, or pass --platform.' });
  }
  return configured;
}

export function appStore(context: Context): AppStoreConnect {
  return new AppStoreConnect(ascCredentials(context.loaded), context.out, context.env.ASC_API_URL || undefined);
}

export function googlePlay(context: Context): GooglePlay {
  const packageName = context.loaded.config.android?.packageName;
  if (!packageName) throw new CliError('No Android package configured.', { hint: 'Set android.packageName in searvia.config.json or GOOGLE_PLAY_PACKAGE_NAME.' });
  return new GooglePlay(playCredentials(context.loaded), packageName, context.out);
}

export function list(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length ? (value as string[]) : undefined;
}

export function dryRunNote(context: Context, what = 'Nothing was changed'): void {
  if (!context.apply) context.out.log(context.out.paint('yellow', `\nDry run. ${what}; run again with --yes to apply.`));
}
