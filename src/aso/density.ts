import { chars } from '../core/util.js';
import { filler } from './rules.js';
import { phrase, words } from './words.js';

/**
 * Google Play keyword density (offline): how often each keyword appears in the title, short and full description,
 * its density (words the phrase covers / words in the field) and whether it appears in the opening of the full
 * description (first 300 characters). Google Play's metadata policy forbids repetitive and irrelevant keyword
 * stuffing: a phrase above 3% of the full description, three times in the short description or a repeated title word
 * gets a warning.
 */

export const FIELDS = ['title', 'short_description', 'full_description'] as const;
export type PlayField = (typeof FIELDS)[number];

/** Above this share of the full description a phrase counts as stuffing. */
export const MAX_DENSITY = 3.0;

/** The "opening" of the full description, shown before "more". */
export const EARLY = 300;

export interface DensityRow {
  keyword: string;
  counts: Record<PlayField, number>;
  density: Record<PlayField, number>;
  early: boolean;
}

export interface DensityResult {
  fields: Record<PlayField, { words: number }>;
  keywords: DensityRow[];
  warnings: Array<{ field: PlayField; message: string }>;
  missing: string[];
}

function occurrences(list: string[], needed: string[]): number {
  const size = needed.length;
  if (size === 0 || list.length < size) return 0;
  let count = 0;
  for (let index = 0; index <= list.length - size; index++) {
    if (needed.every((word, offset) => list[index + offset] === word)) count++;
  }
  return count;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export function analyze(fields: Partial<Record<PlayField, string | null>>, keywords: string[], language?: string | null): DensityResult {
  const fieldWords = Object.fromEntries(FIELDS.map((field) => [field, words(fields[field])])) as Record<PlayField, string[]>;
  const opening = [...(fields.full_description ?? '')].slice(0, EARLY).join('');
  const warnings: Array<{ field: PlayField; message: string }> = [];

  const rows: DensityRow[] = [...new Set(keywords)].map((keyword) => {
    const needed = words(keyword);
    const counts = {} as Record<PlayField, number>;
    const density = {} as Record<PlayField, number>;
    for (const field of FIELDS) {
      counts[field] = occurrences(fieldWords[field], needed);
      density[field] = fieldWords[field].length === 0 ? 0 : round1(((counts[field] * needed.length) / fieldWords[field].length) * 100);
    }

    if (density.full_description > MAX_DENSITY && counts.full_description >= 3) {
      warnings.push({
        field: 'full_description',
        message: `“${keyword}” makes up ${density.full_description}% of the full description (${counts.full_description} times). Google Play treats repeated keywords as spam; keep it under ${MAX_DENSITY}%.`,
      });
    }
    if (counts.short_description >= 3) {
      warnings.push({
        field: 'short_description',
        message: `“${keyword}” appears ${counts.short_description} times in the short description; once reads better and ranks the same.`,
      });
    }
    if (counts.title >= 2) warnings.push({ field: 'title', message: `“${keyword}” appears ${counts.title} times in the title.` });

    return { keyword, counts, density, early: phrase(opening, keyword) };
  });

  // Untracked single words repeated too often are stuffing as well.
  const full = fieldWords.full_description;
  const total = full.length;
  const fillers = filler(language);
  const tally = new Map<string, number>();
  for (const word of full) tally.set(word, (tally.get(word) ?? 0) + 1);
  for (const [word, count] of tally) {
    if (total > 0 && count >= 6 && (count / total) * 100 > 4 && chars(word) > 2 && !fillers.includes(word)) {
      warnings.push({
        field: 'full_description',
        message: `“${word}” is repeated ${count} times (${round1((count / total) * 100)}% of the full description). Google Play may see this as keyword stuffing.`,
      });
    }
  }

  const titleTally = new Map<string, number>();
  for (const word of fieldWords.title) titleTally.set(word, (titleTally.get(word) ?? 0) + 1);
  const titleRepeats = [...titleTally].filter(([, count]) => count > 1).map(([word]) => word);
  if (titleRepeats.length) warnings.push({ field: 'title', message: `The title repeats “${titleRepeats.join(', ')}”; use the space for another keyword.` });

  const seen = new Set<string>();
  return {
    fields: Object.fromEntries(FIELDS.map((field) => [field, { words: fieldWords[field].length }])) as Record<PlayField, { words: number }>,
    keywords: rows,
    warnings: warnings.filter((warning) => {
      if (seen.has(warning.message)) return false;
      seen.add(warning.message);
      return true;
    }),
    missing: rows.filter((row) => FIELDS.every((field) => row.counts[field] === 0)).map((row) => row.keyword),
  };
}
