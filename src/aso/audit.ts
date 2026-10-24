import { chars } from '../core/util.js';
import type { AppleLocaleFields } from '../metadata/apple.js';
import type { PlayLocaleFields } from '../metadata/play.js';
import { analyze } from './density.js';
import { localesFor, STOREFRONTS } from './locales.js';
import { type AppleFields, type Issue, LIMITS, type Packed, pack, review } from './rules.js';

export interface LocaleAudit {
  locale: string;
  score: number;
  used?: number;
  budget?: number;
  issues: Issue[];
  /** Storefronts in which this locale shares search with other locales of the app. */
  storefronts?: string[];
}

export interface AuditReport {
  platform: 'ios' | 'android';
  score: number;
  locales: LocaleAudit[];
}

function toAppleFields(fields: AppleLocaleFields): AppleFields {
  return { title: fields.name ?? '', subtitle: fields.subtitle ?? '', keywords: fields.keywords ?? '' };
}

/**
 * Storefronts that matter for the cross-locale check: the configured countries, else every storefront in which at
 * least two of the app's locales are indexed together (e.g. Turkey indexes both en-GB and tr).
 */
export function relevantStorefronts(present: string[], countries?: string[]): string[] {
  if (countries?.length) return countries.map((country) => country.toUpperCase());
  return Object.keys(STOREFRONTS).filter((country) => (STOREFRONTS[country] as string[]).filter((locale) => present.includes(locale)).length >= 2);
}

const extraLimit = (field: string, value: string | undefined, limit: number): Issue | undefined =>
  value !== undefined && chars(value) > limit ? { kind: 'error', rule: 'limit', message: `${field} is ${chars(value)}/${limit} characters.`, words: [] } : undefined;

export function auditApple(locales: Record<string, AppleLocaleFields>, options: { countries?: string[]; brand?: string[]; avoid?: string[] } = {}): AuditReport {
  const present = Object.keys(locales);
  const storefronts = relevantStorefronts(present, options.countries);
  const results: LocaleAudit[] = present.map((locale) => {
    const siblings: Record<string, AppleFields> = {};
    let primary: boolean | undefined;
    const shared: string[] = [];
    for (const country of storefronts) {
      const indexed = localesFor(country);
      if (!indexed.includes(locale)) continue;
      const others = indexed.filter((other) => other !== locale && present.includes(other));
      if (others.length === 0) continue;
      shared.push(country);
      if (indexed[0] === locale) primary = true;
      else primary ??= false;
      for (const other of others) siblings[other] = toAppleFields(locales[other] as AppleLocaleFields);
    }
    const fields = locales[locale] as AppleLocaleFields;
    const result = review(toAppleFields(fields), { siblings, primary: primary ?? true, avoid: options.avoid, brand: options.brand, language: locale });
    const extra = [
      extraLimit('Promotional text', fields.promotional_text, LIMITS.apple.promotional_text),
      extraLimit('Description', fields.description, LIMITS.apple.description),
      extraLimit('What’s New', fields.release_notes, LIMITS.apple.whats_new),
    ].filter((issue): issue is Issue => issue !== undefined);
    const score = Math.max(0, result.score - extra.length * 12);
    return { locale, score, used: result.used, budget: result.budget, issues: [...extra, ...result.issues], storefronts: shared };
  });
  return { platform: 'ios', score: average(results), locales: results };
}

export function auditPlay(locales: Record<string, PlayLocaleFields>, options: { keywords?: string[] } = {}): AuditReport {
  const results: LocaleAudit[] = Object.entries(locales).map(([locale, fields]) => {
    const issues: Issue[] = [];
    for (const [field, label, limit] of [
      ['title', 'Title', LIMITS.google.title],
      ['short_description', 'Short description', LIMITS.google.short_description],
      ['full_description', 'Full description', LIMITS.google.full_description],
    ] as const) {
      const value = fields[field];
      if (value !== undefined && chars(value) > limit) issues.push({ kind: 'error', rule: 'limit', message: `${label} is ${chars(value)}/${limit} characters.`, words: [] });
    }
    if (!fields.title) issues.push({ kind: 'error', rule: 'title', message: 'The title is empty.', words: [] });
    if (!fields.short_description)
      issues.push({ kind: 'warning', rule: 'short_description', message: 'The short description is empty; it is indexed and shown above the fold.', words: [] });
    const density = analyze(fields, options.keywords ?? [], locale);
    for (const warning of density.warnings) issues.push({ kind: 'warning', rule: 'stuffing', message: warning.message, words: [] });
    for (const keyword of density.missing)
      issues.push({ kind: 'warning', rule: 'missing', message: `“${keyword}” does not appear in the title, short or full description.`, words: [keyword] });
    for (const row of density.keywords) {
      if (row.counts.full_description > 0 && !row.early)
        issues.push({ kind: 'info', rule: 'opening', message: `“${row.keyword}” is not in the first ${300} characters of the full description.`, words: [row.keyword] });
    }
    const penalty = issues.reduce((sum, issue) => sum + (issue.kind === 'error' ? 12 : issue.kind === 'warning' ? 5 : 0), 0);
    return { locale, score: Math.max(0, 100 - penalty), issues };
  });
  return { platform: 'android', score: average(results), locales: results };
}

function average(results: LocaleAudit[]): number {
  return results.length ? Math.round(results.reduce((sum, item) => sum + item.score, 0) / results.length) : 0;
}

/** `audit --fix`: the packed keyword field per locale. */
export function fixApple(locales: Record<string, AppleLocaleFields>, options: { lead?: string[]; avoid?: string[] } = {}): Record<string, Packed> {
  const out: Record<string, Packed> = {};
  for (const [locale, fields] of Object.entries(locales)) {
    out[locale] = pack(toAppleFields(fields), { lead: options.lead, avoid: options.avoid, language: locale });
  }
  return out;
}
