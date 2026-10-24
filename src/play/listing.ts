import { changed, type FieldChange, normalise } from '../core/diff.js';
import { CliError } from '../core/errors.js';
import { chars } from '../core/util.js';
import { PLAY_FIELD_NAMES, PLAY_FIELDS, type PlayField, type PlayLocaleFields } from '../metadata/play.js';
import type { GooglePlay, Listing } from './client.js';

export function listingToFields(listing: Listing): PlayLocaleFields {
  const fields: PlayLocaleFields = {};
  for (const field of PLAY_FIELD_NAMES) fields[field] = (listing[PLAY_FIELDS[field].attribute as keyof Listing] as string | undefined) ?? '';
  return fields;
}

export function checkPlayLimits(locales: Record<string, PlayLocaleFields>): string[] {
  const issues: string[] = [];
  for (const [locale, fields] of Object.entries(locales)) {
    for (const field of PLAY_FIELD_NAMES) {
      const value = fields[field];
      const limit = (PLAY_FIELDS[field] as { limit?: number }).limit;
      if (value !== undefined && limit && chars(value) > limit) issues.push(`${locale} ${field} is ${chars(value)}/${limit} characters.`);
    }
  }
  return issues;
}

export interface PlayPushPlan {
  changes: FieldChange[];
  missingLocales: string[];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function planPlayPush(remote: Listing[], local: Record<string, PlayLocaleFields>, only?: PlayField[]): PlayPushPlan {
  const changes: FieldChange[] = [];
  const missing: string[] = [];
  for (const [locale, fields] of Object.entries(local)) {
    const listing = remote.find((item) => same(item.language, locale));
    const remoteFields = listing ? listingToFields(listing) : undefined;
    let any = false;
    for (const field of PLAY_FIELD_NAMES) {
      if (!(field in fields) || (only && !only.includes(field))) continue;
      if (!changed(remoteFields?.[field], fields[field])) continue;
      changes.push({ platform: 'android', locale, field, before: normalise(remoteFields?.[field]), after: normalise(fields[field]) });
      any = true;
    }
    if (any && !listing) missing.push(locale);
  }
  return { changes, missingLocales: missing };
}

/** Writes the plan into an open edit: PATCH for existing listings, PUT (create) for new languages. */
export async function applyPlayPush(
  play: GooglePlay,
  editId: string,
  remote: Listing[],
  local: Record<string, PlayLocaleFields>,
  plan: PlayPushPlan,
  options: { createLocales?: boolean },
): Promise<number> {
  if (plan.missingLocales.length && !options.createLocales) {
    throw new CliError(`These languages have no Google Play listing yet: ${plan.missingLocales.join(', ')}.`, { hint: 'Run again with --create-locales to add them.' });
  }
  const locales = [...new Set(plan.changes.map((change) => change.locale))];
  for (const locale of locales) {
    const body: Record<string, string> = {};
    for (const change of plan.changes.filter((item) => item.locale === locale)) body[PLAY_FIELDS[change.field as PlayField].attribute] = change.after ?? '';
    const existing = remote.find((item) => same(item.language, locale));
    if (existing) await play.patchListing(editId, existing.language, body);
    else {
      const fields = local[locale] ?? {};
      if (!fields.title) throw new CliError(`A new ${locale} listing needs title.txt.`);
      const full: Record<string, string> = {};
      for (const field of PLAY_FIELD_NAMES) if (fields[field]) full[PLAY_FIELDS[field].attribute] = fields[field] as string;
      await play.updateListing(editId, locale, full);
    }
  }
  return plan.changes.length;
}
