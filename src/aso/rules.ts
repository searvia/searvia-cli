import { bytes, chars, unique } from '../core/util.js';
import { localeName } from './locales.js';
import { unspaced, words } from './words.js';

/**
 * App Store metadata rules (offline, no model). Apple indexes the title (30 characters), subtitle (30 characters) and
 * the keyword field (100 BYTES: accented letters such as Turkish ç/ş/ğ/ı/ö/ü count 2, Chinese/Japanese/Korean 3) as
 * one pool.
 *
 * `review` scores one localization (0–100; an error costs 12 points, a warning 5, per word up to three): pool usage,
 * zero repetition across fields, no filler words or singular/plural twins, no other brands or category words, the
 * keyword field format (comma separated, no space after commas) and overlap with other localizations indexed in the
 * same storefront. `pack` repairs the keyword field in code. Same rules as Searvia's metadata audit.
 */

/** The pool Apple indexes: title 30 + subtitle 30 + keyword field 100. */
export const BUDGET = 160;

export const LIMITS = {
  apple: { title: 30, subtitle: 30, keywords: 100, promotional_text: 170, description: 4000, whats_new: 4000 },
  google: { title: 30, short_description: 80, full_description: 4000, release_notes: 500 },
} as const;

/**
 * Words with no search value that only spend characters, per language (a filler word in one language can be a real
 * search in another: Spanish "para" = for, Turkish "para" = money). `*` applies to every language.
 */
export const FILLER: Record<string, string[]> = {
  '*': ['app', 'apps', 'pro', 'plus', 'hd', 'lite', 'free'],
  en: [
    'best',
    'top',
    'new',
    'the',
    'a',
    'an',
    'and',
    'or',
    'of',
    'for',
    'with',
    'your',
    'my',
    'in',
    'on',
    'to',
    'by',
    'from',
    'official',
    'ultimate',
    'amazing',
    'easy',
    'simple',
    'fast',
    'great',
    'good',
  ],
  tr: ['ve', 'ile', 'için', 'en', 'iyi', 'ücretsiz', 'uygulama', 'uygulaması', 'bir', 'bu', 'da', 'de', 'yeni'],
  de: ['und', 'mit', 'für', 'kostenlos', 'beste', 'der', 'die', 'das', 'neu'],
  fr: ['et', 'pour', 'avec', 'gratuit', 'meilleur', 'le', 'la', 'les', 'de', 'nouveau'],
  es: ['y', 'con', 'para', 'gratis', 'mejor', 'el', 'la', 'de', 'nuevo'],
  pt: ['e', 'com', 'para', 'grátis', 'melhor', 'o', 'a', 'de', 'novo'],
  it: ['e', 'con', 'per', 'gratis', 'migliore', 'il', 'la', 'di', 'nuovo'],
};

/** Category and platform names: Apple indexes them already, they waste the keyword field. */
export const CATEGORY = ['app', 'apps', 'application', 'game', 'games', 'iphone', 'ipad', 'ios', 'apple', 'android', 'mobile', 'uygulama', 'oyun'];

const PENALTY = { error: 12, warning: 5, info: 0, good: 0 } as const;

export type IssueKind = keyof typeof PENALTY;

export interface Issue {
  kind: IssueKind;
  rule: string;
  message: string;
  words: string[];
}

export interface Review {
  score: number;
  issues: Issue[];
  used: number;
  budget: number;
}

export interface AppleFields {
  title?: string | null;
  subtitle?: string | null;
  keywords?: string | null;
}

/** Filler words of a language (English when unknown); `language` like tr, en-GB, pt-BR. */
export function filler(language?: string | null): string[] {
  const code = (language ?? '').split('-')[0]?.toLowerCase() ?? '';
  return [...(FILLER['*'] as string[]), ...(FILLER[code] ?? (FILLER.en as string[]))];
}

/** Field length: the keyword field in bytes, everything else in characters. */
export function fieldLength(field: string, value: string | null | undefined): number {
  return field === 'keywords' ? bytes(value) : chars(value);
}

/** Keyword field items (comma separated, trimmed, lowercase, empties dropped). */
export function items(keywords: string | null | undefined): string[] {
  return (keywords ?? '')
    .split(',')
    .map((item) => item.toLowerCase().trim())
    .filter((item) => item !== '');
}

const intersect = (a: string[], b: string[]) => a.filter((word) => b.includes(word));
const diff = (a: string[], b: string[]) => a.filter((word) => !b.includes(word));

export interface ReviewOptions {
  /** Other localizations indexed in the same storefront (locale → fields). */
  siblings?: Record<string, AppleFields>;
  /** Is this the storefront's main localization (in an overlap the other one should change). */
  primary?: boolean;
  /** Other companies' brand words. */
  avoid?: string[];
  /** Language of the localization (for filler words). */
  language?: string | null;
  /** The app's own brand words (expected in every title, not counted as overlap). */
  brand?: string[];
}

export function review(fields: AppleFields, options: ReviewOptions = {}): Review {
  const { siblings = {}, primary = true, avoid = [], language = null, brand = [] } = options;
  const fillers = filler(language);
  const title = fields.title ?? '';
  const subtitle = fields.subtitle ?? '';
  const keywords = fields.keywords ?? '';
  const titleWords = words(title);
  const subtitleWords = words(subtitle);
  const keywordItems = items(keywords);
  const keywordWords = (keywordItems.length ? keywordItems : ['']).flatMap((item) => words(item));
  const all = unique([...titleWords, ...subtitleWords, ...keywordWords]);
  const issues: Issue[] = [];
  const add = (kind: IssueKind, rule: string, message: string, list: string[] = []) => issues.push({ kind, rule, message, words: [...list] });
  const quote = (list: string[]) => `“${list.join(', ')}”`;

  // 1. Limits and the 160-character pool.
  const keywordBytes = bytes(keywords);
  const used = chars(title) + chars(subtitle) + keywordBytes;

  for (const [text, label] of [
    [title, 'Title'],
    [subtitle, 'Subtitle'],
  ] as const) {
    if (chars(text) > 30) add('error', 'budget', `${label} is ${chars(text)}/30 characters.`);
  }

  if (keywordBytes > 100) {
    add('error', 'budget', `The keyword field is ${keywordBytes}/100 bytes. Accented letters count 2 bytes, Chinese, Japanese and Korean characters 3.`);
  }

  if (used < 140) add('warning', 'budget', `Only ${used} of the 160 indexed characters are used; every unused character is a lost ranking chance.`);
  else add('good', 'budget', `${Math.min(used, BUDGET)}/160 indexed characters used.`);

  if (keywordBytes >= 95 && keywordBytes <= 100) add('good', 'keywords', `The keyword field is full (${keywordBytes}/100 bytes).`);
  else if (keywordItems.length === 0) add('warning', 'keywords', 'The keyword field is empty: 100 bytes of search space unused.');
  else if (keywordBytes < 90) add('warning', 'keywords', `The keyword field has ${100 - keywordBytes} unused bytes.`);

  // 2. Zero repetition: every word lives in one field.
  const titleSet = unique(titleWords);
  const subtitleSet = unique(subtitleWords);
  const keywordSet = unique(keywordWords);
  const both = intersect(titleSet, subtitleSet);
  const inTitle = intersect(titleSet, keywordSet);
  const inSubtitle = diff(intersect(subtitleSet, keywordSet), inTitle);

  // Unspaced languages: an item inside the title/subtitle text is a repetition.
  for (const item of keywordItems) {
    if (unspaced(item)) {
      if (title.toLowerCase().includes(item)) inTitle.push(item);
      else if (subtitle.toLowerCase().includes(item)) inSubtitle.push(item);
    }
  }

  if (both.length) add('error', 'repetition', `${quote(both)} appear in both the title and the subtitle; each word should live in one field.`, both);
  if (inTitle.length) add('error', 'repetition', `${quote(unique(inTitle))} are in the title and again in the keyword field.`, unique(inTitle));
  if (inSubtitle.length) add('error', 'repetition', `${quote(unique(inSubtitle))} are in the subtitle and again in the keyword field.`, unique(inSubtitle));

  const twice = unique(keywordWords.filter((word, index) => keywordWords.indexOf(word) !== index));
  if (twice.length) add('error', 'repetition', `${quote(twice)} appear more than once in the keyword field.`, twice);

  // 3. Filler, singular/plural twins, other brands, category words.
  const fillerFound = intersect(all, fillers);
  if (fillerFound.length) add('warning', 'filler', `${quote(fillerFound)} have no search value; spend the characters on real search words.`, fillerFound);

  const plurals = all.filter((word) => chars(word) > 3 && word.endsWith('s') && all.includes([...word].slice(0, -1).join('')));
  if (plurals.length) add('warning', 'singular', `Both singular and plural are present (${plurals.join(', ')}); Apple matches plurals from the singular.`, plurals);

  const brands = intersect(
    all,
    avoid.map((word) => word.toLowerCase()),
  );
  if (brands.length) {
    add('error', 'brand', `${quote(brands)} belong to another company’s brand. Apple rejects listings that use other brands, and the words rarely convert.`, brands);
  }

  const category = diff(intersect(unique(keywordWords), CATEGORY), fillerFound);
  if (category.length) add('warning', 'category', `${quote(category)} are category or platform words Apple already indexes; they waste the keyword field.`, category);

  // 4. Keyword field format.
  if (keywords.includes(', ') || keywords.includes(' ,')) add('error', 'format', 'Spaces next to commas waste bytes: write “a,b”, not “a, b”.');

  const phrases = keywordItems.filter((item) => item.includes(' '));
  if (phrases.length) {
    add('warning', 'format', `${quote(phrases)} are phrases; Apple combines single words across fields, so split them and spend the saved bytes on new words.`, phrases);
  }

  const trimmed = keywords.trim();
  if (trimmed.endsWith(',') || trimmed.startsWith(',') || /,\s*,/.test(keywords)) add('warning', 'format', 'Empty keyword slot (a leading, trailing or double comma).');

  // 5. Title and subtitle.
  if (titleWords.length === 0) add('error', 'title', 'The title is empty.');
  if (subtitleWords.length === 0) add('warning', 'subtitle', 'The subtitle is empty; it is an indexed field and the first line people read in search results.');

  // 6. Localizations indexed in the same storefront should not repeat each other.
  const brandWords = brand.flatMap((word) => words(word));
  for (const [locale, sibling] of Object.entries(siblings)) {
    const other = unique([...words(sibling.title), ...words(sibling.subtitle), ...words(items(sibling.keywords).join(' '))]);
    const overlap = diff(diff(intersect(all, other), fillers), brandWords);
    if (overlap.length === 0) continue;
    const name = localeName(locale);
    const sample = overlap.slice(0, 6).join(', ');
    if (primary)
      add('info', 'locales', `${name} repeats ${overlap.length} of these words (${sample}); rewrite ${name} to add new words, the primary listing keeps the best ones.`, overlap);
    else add('warning', 'locales', `${overlap.length} words also appear in ${name} (${sample}); an additional localization should add new words, not repeat them.`, overlap);
  }

  const order: Record<IssueKind, number> = { error: 0, warning: 1, info: 2, good: 3 };
  issues.sort((a, b) => order[a.kind] - order[b.kind]);
  const penalty = issues.reduce((sum, issue) => sum + PENALTY[issue.kind] * Math.max(1, Math.min(3, issue.words.length)), 0);

  return { score: Math.max(0, 100 - penalty), issues, used, budget: BUDGET };
}

export interface Packed {
  keywords: string;
  bytes: number;
  dropped: string[];
  added: string[];
  notes: string[];
}

/**
 * Repairs the keyword field: first `lead` (most valuable candidates), then the words already in the field, then
 * `tail`. Words in the title/subtitle, filler, category and other-brand words, repeats and plural twins are dropped;
 * the rest is packed in order into 100 bytes (a comma is 1 byte).
 */
export function pack(fields: AppleFields, options: { lead?: string[]; tail?: string[]; avoid?: string[]; language?: string | null } = {}): Packed {
  const { lead = [], tail = [], avoid = [], language = null } = options;
  const fillers = filler(language);
  const avoidWords = avoid.map((word) => word.toLowerCase());
  const title = (fields.title ?? '').toLowerCase();
  const subtitle = (fields.subtitle ?? '').toLowerCase();
  const reserved = unique([...words(title), ...words(subtitle)]);
  const existing: string[] = [];

  for (const item of items(fields.keywords)) {
    // Unspaced languages keep the item whole; elsewhere phrases are split into single words.
    existing.push(...(unspaced(item) ? [item.replace(/[^\p{L}\p{N}\p{M}]+/gu, '')] : words(item)));
  }

  const kept = new Map<string, 'lead' | 'field' | 'tail'>();
  const dropped: string[] = [];

  for (const [source, list] of [
    ['lead', lead],
    ['field', existing],
    ['tail', tail],
  ] as const) {
    for (const raw of list) {
      const word = String(raw).trim().toLowerCase();
      const isUnspaced = unspaced(word);
      if (word === '' || (!isUnspaced && chars(word) < 2) || kept.has(word)) continue;

      const twin = word.endsWith('s') ? [...word].slice(0, -1).join('') : `${word}s`;
      const wasted =
        reserved.includes(word) ||
        reserved.includes(twin) ||
        (isUnspaced && (title.includes(word) || subtitle.includes(word))) ||
        fillers.includes(word) ||
        CATEGORY.includes(word) ||
        avoidWords.includes(word);

      if (wasted) {
        if (source === 'field') dropped.push(word);
        continue;
      }

      // Singular and plural: keep only the singular (Apple matches the plural from it).
      if (word.endsWith('s') && kept.has(twin)) continue;
      if (kept.has(`${word}s`)) kept.delete(`${word}s`);

      kept.set(word, source);
    }
  }

  const packed: string[] = [];
  let size = 0;
  for (const word of kept.keys()) {
    const cost = bytes(word) + (packed.length === 0 ? 0 : 1);
    if (size + cost <= 100) {
      packed.push(word);
      size += cost;
    }
  }

  const trimmedCount = kept.size - packed.length;
  const added = packed.filter((word) => kept.get(word) !== 'field' && !existing.includes(word));
  const droppedUnique = unique(dropped);
  const notes: string[] = [];
  if (droppedUnique.length) {
    notes.push(`Removed from the keyword field (already in the title, subtitle or another indexed localization, or filler, category or brand words): ${droppedUnique.join(', ')}.`);
  }
  if (added.length) notes.push(`Added from your best tracked keywords: ${added.join(', ')}.`);
  if (trimmedCount > 0) notes.push(`${trimmedCount} lower-ranked words did not fit in 100 bytes.`);

  return { keywords: packed.join(','), bytes: size, dropped: droppedUnique, added, notes };
}
