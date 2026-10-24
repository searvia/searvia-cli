import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listDirs, listImages, localeDirs, readText, writeText } from './files.js';

/**
 * Google Play metadata in fastlane `supply` layout: `<metadata>/android/<locale>/{title,short_description,
 * full_description,video}.txt`, `changelogs/<versionCode>.txt` (or `default.txt`) and `images/…`.
 */
export const PLAY_FIELDS = {
  title: { attribute: 'title', limit: 30 },
  short_description: { attribute: 'shortDescription', limit: 80 },
  full_description: { attribute: 'fullDescription', limit: 4000 },
  video: { attribute: 'video' },
} as const;

export type PlayField = keyof typeof PLAY_FIELDS;
export const PLAY_FIELD_NAMES = Object.keys(PLAY_FIELDS) as PlayField[];
export type PlayLocaleFields = Partial<Record<PlayField, string>>;

/** Image types of edits.images (enum AppImageType) and their fastlane file/folder names. */
export const PLAY_IMAGE_TYPES = [
  'icon',
  'featureGraphic',
  'tvBanner',
  'phoneScreenshots',
  'sevenInchScreenshots',
  'tenInchScreenshots',
  'tvScreenshots',
  'wearScreenshots',
] as const;
export type PlayImageType = (typeof PLAY_IMAGE_TYPES)[number];
export const SINGLE_IMAGE_TYPES: PlayImageType[] = ['icon', 'featureGraphic', 'tvBanner'];

export function readPlayLocales(dir: string, only?: string[]): Record<string, PlayLocaleFields> {
  const out: Record<string, PlayLocaleFields> = {};
  for (const locale of localeDirs(dir)) {
    if (only?.length && !only.includes(locale)) continue;
    const fields: PlayLocaleFields = {};
    for (const field of PLAY_FIELD_NAMES) {
      const value = readText(join(dir, locale, `${field}.txt`));
      if (value !== undefined) fields[field] = value;
    }
    out[locale] = fields;
  }
  return out;
}

export function writePlayLocale(dir: string, locale: string, fields: PlayLocaleFields): string[] {
  const written: string[] = [];
  for (const field of PLAY_FIELD_NAMES) {
    if (!(field in fields)) continue;
    const path = join(dir, locale, `${field}.txt`);
    // Empty store fields only overwrite files that exist (no clutter of empty files after a pull).
    if (!fields[field] && !existsSync(path)) continue;
    writeText(path, fields[field] ?? '');
    written.push(path);
  }
  return written;
}

/** Release notes for a version code: changelogs/<versionCode>.txt, else changelogs/default.txt. */
export function readChangelog(dir: string, locale: string, versionCode?: number | string): string | undefined {
  if (versionCode !== undefined) {
    const specific = readText(join(dir, locale, 'changelogs', `${versionCode}.txt`));
    if (specific) return specific;
  }
  return readText(join(dir, locale, 'changelogs', 'default.txt')) || undefined;
}

export function writeChangelog(dir: string, locale: string, versionCode: number | string, text: string): string {
  const path = join(dir, locale, 'changelogs', `${versionCode}.txt`);
  writeText(path, text);
  return path;
}

/** Local images per type for a locale (`images/icon.png`, `images/phoneScreenshots/*.png`…). */
export function readPlayImages(dir: string, locale: string): Partial<Record<PlayImageType, string[]>> {
  const base = join(dir, locale, 'images');
  const out: Partial<Record<PlayImageType, string[]>> = {};
  if (!existsSync(base)) return out;
  const files = readdirSync(base);
  for (const type of PLAY_IMAGE_TYPES) {
    if (SINGLE_IMAGE_TYPES.includes(type)) {
      const file = files.find((name) => new RegExp(`^${type}\\.(png|jpe?g)$`, 'i').test(name));
      if (file) out[type] = [join(base, file)];
    } else if (listDirs(base).includes(type)) {
      out[type] = listImages(join(base, type));
    }
  }
  return out;
}

export function playLocales(dir: string): string[] {
  return localeDirs(dir);
}
