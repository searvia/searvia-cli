import { basename } from 'node:path';
import type { ManualStep, ReleaseStep } from '../apple/release.js';
import { CliError } from '../core/errors.js';
import type { Output } from '../core/output.js';
import { chars, formatBytes } from '../core/util.js';
import { type PlayImageType, type PlayLocaleFields, playLocales, readChangelog } from '../metadata/play.js';
import type { GooglePlay, Track, TrackRelease } from './client.js';
import { type LocalPlayImage, syncPlayImages } from './images.js';
import { applyPlayPush, checkPlayLimits, planPlayPush } from './listing.js';

export interface PlayReleaseOptions {
  apply: boolean;
  track: string;
  aab?: string;
  versionCodes?: number[];
  status?: TrackRelease['status'];
  /** Percentage 0–100 for a staged rollout. */
  rollout?: number;
  releaseName?: string;
  metadataDir: string;
  listings?: Record<string, PlayLocaleFields>;
  images?: Record<string, Partial<Record<PlayImageType, LocalPlayImage[]>>>;
  createLocales?: boolean;
  changesNotSentForReview?: boolean;
  out?: Output;
}

export const PLAY_MANUAL_STEPS: ManualStep[] = [
  {
    item: 'App content declarations (Data safety, content rating questionnaire, target audience, ads, app access)',
    why: 'The Google Play Developer API has no endpoints for the App content forms; they are required before the first production release and when they change.',
    url: 'https://play.google.com/console › your app › Policy and programs › App content',
  },
  {
    item: 'Creating the app',
    why: 'Apps are created in Play Console (the API cannot create them).',
    url: 'https://play.google.com/console › Create app',
  },
];

/** Release notes per language for a version code (changelogs/<code>.txt or default.txt), max 500 characters each. */
export function collectReleaseNotes(dir: string, versionCode: number | undefined): Array<{ language: string; text: string }> {
  const notes: Array<{ language: string; text: string }> = [];
  for (const locale of playLocales(dir)) {
    const text = readChangelog(dir, locale, versionCode);
    if (!text) continue;
    if (chars(text) > 500) throw new CliError(`${locale} release notes are ${chars(text)}/500 characters.`);
    notes.push({ language: locale, text });
  }
  return notes;
}

function rolloutStatus(options: PlayReleaseOptions): { status: NonNullable<TrackRelease['status']>; userFraction?: number } {
  if (options.rollout !== undefined && (options.rollout <= 0 || options.rollout > 100)) throw new CliError('--rollout must be between 0 (exclusive) and 100.');
  if (options.status === 'inProgress' || options.status === 'halted' || (options.status === undefined && options.rollout !== undefined && options.rollout < 100)) {
    const fraction = (options.rollout ?? 10) / 100;
    if (fraction >= 1) throw new CliError('A staged rollout needs --rollout below 100.');
    return { status: options.status ?? 'inProgress', userFraction: fraction };
  }
  return { status: options.status ?? 'completed' };
}

/**
 * Google Play in one edit: listings → images → bundle (resumable upload) → track release (status, rollout fraction,
 * release notes) → commit. Without `apply` the edit is opened, compared and discarded.
 * https://developers.google.com/android-publisher/edits
 */
export async function releasePlay(play: GooglePlay, options: PlayReleaseOptions): Promise<{ steps: ReleaseStep[]; manual: ManualStep[]; versionCodes: number[] }> {
  const steps: ReleaseStep[] = [];
  const out = options.out;
  const record = (step: string, status: ReleaseStep['status'], detail?: string) => {
    steps.push({ step, status, detail });
    const mark = status === 'done' ? '✓' : status === 'planned' ? '→' : '·';
    out?.log(`  ${mark} ${step}${detail ? `: ${detail}` : ''}${status === 'planned' ? ' (dry run)' : ''}`);
  };
  const apply = options.apply;
  let versionCodes = [...(options.versionCodes ?? [])];

  await play.withEdit(
    async (editId) => {
      record('edit', apply ? 'done' : 'planned', `opened ${editId}`);

      // 1. Listings
      if (options.listings && Object.keys(options.listings).length) {
        const limits = checkPlayLimits(options.listings);
        if (limits.length) throw new CliError(`Store listing exceeds limits:\n  ${limits.join('\n  ')}`);
        const remote = await play.listings(editId);
        const plan = planPlayPush(remote, options.listings);
        if (plan.changes.length === 0) record('store listing', 'unchanged');
        else if (!apply) record('store listing', 'planned', `${plan.changes.length} field changes`);
        else {
          await applyPlayPush(play, editId, remote, options.listings, plan, { createLocales: options.createLocales });
          record('store listing', 'done', `${plan.changes.length} field changes`);
        }
      } else record('store listing', 'skipped', 'no metadata folder');

      // 2. Images
      if (options.images && Object.keys(options.images).length) {
        const plans = await syncPlayImages(play, editId, options.images, { apply, out });
        const changed = plans.filter((plan) => plan.action !== 'unchanged').length;
        record('images', changed === 0 ? 'unchanged' : apply ? 'done' : 'planned', `${changed} of ${plans.length} image types ${apply ? 'replaced' : 'to replace'}`);
      } else record('images', 'skipped', 'no images');

      // 3. Bundle
      if (options.aab) {
        if (apply) {
          out?.step(`Uploading ${basename(options.aab)}`);
          const bundle = await play.uploadBundle(editId, options.aab, { onProgress: (sent, total) => out?.debug(`${formatBytes(sent)} / ${formatBytes(total)}`) });
          versionCodes = [...versionCodes, bundle.versionCode];
          record('bundle upload', 'done', `versionCode ${bundle.versionCode}`);
        } else record('bundle upload', 'planned', basename(options.aab));
      }

      // 4. Track
      const { status, userFraction } = rolloutStatus(options);
      if (versionCodes.length || (options.aab && !apply)) {
        const newest = versionCodes.length ? Math.max(...versionCodes) : undefined;
        const releaseNotes = collectReleaseNotes(options.metadataDir, newest);
        const release: TrackRelease = {
          name: options.releaseName,
          versionCodes: versionCodes.map(String),
          status,
          ...(userFraction !== undefined ? { userFraction } : {}),
          ...(releaseNotes.length ? { releaseNotes } : {}),
        };
        if (apply) await play.updateTrack(editId, { track: options.track, releases: [release] });
        record(
          'track',
          apply ? 'done' : 'planned',
          `${options.track}: ${versionCodes.join(', ') || 'new bundle'} ${status}${userFraction !== undefined ? ` ${Math.round(userFraction * 100)}%` : ''}, ${releaseNotes.length} release note languages`,
        );
      } else if (options.status || options.rollout !== undefined) {
        // No new build: change the rollout of the release already in the track (raise %, halt, resume, complete).
        const current: Track = await play.track(editId, options.track);
        const staged = (current.releases ?? []).find((release) => release.status === 'inProgress' || release.status === 'halted');
        if (!staged) throw new CliError(`Track ${options.track} has no staged rollout to change.`);
        const updated: TrackRelease = { ...staged, status, userFraction };
        if (status === 'completed') delete updated.userFraction;
        if (apply) await play.updateTrack(editId, { track: options.track, releases: [updated] });
        record(
          'rollout',
          apply ? 'done' : 'planned',
          `${options.track} ${staged.versionCodes?.join(', ')}: ${staged.status} → ${status}${userFraction !== undefined ? ` ${Math.round(userFraction * 100)}%` : ''}`,
        );
      } else record('track', 'skipped', 'no bundle or version code given');

      if (apply) record('commit', 'done', options.changesNotSentForReview ? 'changes not sent for review' : 'sent for review');
      else record('commit', 'planned');
    },
    { commit: apply, changesNotSentForReview: options.changesNotSentForReview },
  );

  return { steps, manual: PLAY_MANUAL_STEPS, versionCodes };
}

export async function playStatus(play: GooglePlay): Promise<Track[]> {
  return play.withEdit((editId) => play.tracks(editId), { commit: false });
}
