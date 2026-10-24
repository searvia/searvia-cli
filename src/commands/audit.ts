import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type AuditReport, auditApple, auditPlay, fixApple } from '../aso/audit.js';
import { androidMetadataDir, hasAndroid, metadataDir } from '../core/config.js';
import { changed, type FieldChange, renderChanges } from '../core/diff.js';
import { CliError } from '../core/errors.js';
import { readAppleMetadata } from '../metadata/apple.js';
import { writeText } from '../metadata/files.js';
import { readPlayLocales } from '../metadata/play.js';
import { searviaHint } from '../searvia/hint.js';
import { type Command, dryRunNote, list, type Platform } from './context.js';

const MARK = { error: '✗', warning: '!', info: 'i', good: '✓' } as const;
const COLOR = { error: 'red', warning: 'yellow', info: 'blue', good: 'green' } as const;

export const audit: Command = {
  name: 'audit',
  summary: 'Offline ASO audit of your metadata (no keys needed)',
  usage: 'searvia audit [--platform ios|android] [--locale ..] [--country US,TR] [--keywords ..] [--min-score 70] [--fix [--yes]]',
  description:
    'Scores every localization 0–100 with the same rules as Searvia: App Store keyword field in UTF-8 bytes (100), title and subtitle 30 characters, the 160-character indexed pool, repetition across title/subtitle/keywords, filler words, singular/plural twins, other brands, category words, comma format and overlap between localizations indexed in the same storefront. Google Play: field limits and keyword density/stuffing. --fix rewrites keywords.txt (dropping wasted words and packing the 100 bytes).',
  options: [
    { name: 'platform', alias: 'p', type: 'string', value: '<ios|android|all>', description: 'Store to audit (default: every metadata folder found).' },
    { name: 'locale', alias: 'l', type: 'list', value: '<codes>', description: 'Only these locales.' },
    { name: 'country', type: 'list', value: '<codes>', description: 'Storefronts for the cross-locale check (default: config ios.countries, else where your locales overlap).' },
    { name: 'keywords', alias: 'k', type: 'list', value: '<words>', description: 'Target keywords: Play density check, and words to put first with --fix.' },
    { name: 'avoid', type: 'list', value: '<words>', description: 'Competitor brand words that must not appear.' },
    { name: 'min-score', type: 'number', value: '<0-100>', description: 'Exit with code 3 when any locale scores lower (for CI).' },
    { name: 'fix', type: 'boolean', description: 'Repack keywords.txt (dry run unless --yes).' },
    { name: 'show-good', type: 'boolean', description: 'Also list the checks that passed.' },
  ],
  examples: ['searvia audit', 'searvia audit --platform ios --country US,TR --min-score 75', 'searvia audit --fix --keywords "budget,expense" --yes'],
  async run(context) {
    const flag = String(context.options.platform ?? 'all');
    const iosDir = metadataDir(context.loaded);
    const androidDir = androidMetadataDir(context.loaded);
    const wanted: Platform[] = flag === 'all' ? [] : [flag === 'android' ? 'android' : 'ios'];
    const only = list(context.options.locale);
    const ios = context.loaded.config.ios ?? {};
    const keywords = list(context.options.keywords);
    const avoid = [...(list(context.options.avoid) ?? []), ...(ios.avoid ?? [])];
    const reports: AuditReport[] = [];
    const fixes: FieldChange[] = [];

    const apple = readAppleMetadata(iosDir, only);
    if ((wanted.length === 0 || wanted.includes('ios')) && Object.keys(apple.locales).length) {
      const report = auditApple(apple.locales, { countries: list(context.options.country) ?? ios.countries, brand: ios.brand, avoid });
      reports.push(report);
      if (context.options.fix) {
        const packed = fixApple(apple.locales, { lead: keywords ?? ios.keywords, avoid });
        for (const [locale, result] of Object.entries(packed)) {
          const before = apple.locales[locale]?.keywords ?? '';
          if (changed(before, result.keywords)) fixes.push({ platform: 'ios', locale, field: 'keywords', before: before || null, after: result.keywords || null });
        }
      }
    }

    const play = readPlayLocales(androidDir, only);
    if ((wanted.length === 0 || wanted.includes('android')) && Object.keys(play).length) {
      reports.push(auditPlay(play, { keywords: keywords ?? context.loaded.config.android?.keywords }));
    }

    if (reports.length === 0) {
      const hint = existsSync(iosDir) || hasAndroid(context.loaded) ? '' : ' Run `searvia pull` or `searvia init` first.';
      throw new CliError(`No metadata found in ${iosDir}${existsSync(androidDir) ? '' : ` or ${androidDir}`}.${hint}`);
    }

    for (const report of reports) {
      context.out.log(context.out.paint('bold', `${report.platform === 'ios' ? 'App Store' : 'Google Play'} · score ${report.score}/100`));
      for (const locale of report.locales) {
        const color = locale.score >= 80 ? 'green' : locale.score >= 60 ? 'yellow' : 'red';
        const pool = locale.used !== undefined ? context.out.paint('gray', `  ${locale.used}/${locale.budget} indexed`) : '';
        const shared = locale.storefronts?.length ? context.out.paint('gray', `  shares search in ${locale.storefronts.join(', ')}`) : '';
        context.out.log(`\n  ${context.out.paint('bold', locale.locale.padEnd(8))} ${context.out.paint(color, `${String(locale.score).padStart(3)}/100`)}${pool}${shared}`);
        for (const issue of locale.issues) {
          if (issue.kind === 'good' && !context.options.showGood) continue;
          context.out.log(`    ${context.out.paint(COLOR[issue.kind], MARK[issue.kind])} ${issue.message}`);
        }
      }
      context.out.log();
    }

    if (context.options.fix) {
      if (fixes.length === 0) context.out.log('Keyword fields are already packed.');
      else {
        renderChanges(context.out, fixes);
        if (context.apply) {
          for (const fix of fixes) writeText(join(iosDir, fix.locale, 'keywords.txt'), fix.after ?? '');
          context.out.success(`Rewrote ${fixes.length} keywords.txt file${fixes.length === 1 ? '' : 's'}. Push them with \`searvia push --field keywords\`.`);
        } else dryRunNote(context, 'keywords.txt was not changed');
      }
    }

    const minimum = context.options.minScore as number | undefined;
    const failing =
      minimum === undefined
        ? []
        : reports.flatMap((report) => report.locales.filter((locale) => locale.score < minimum).map((locale) => `${report.platform} ${locale.locale} (${locale.score})`));

    searviaHint(context, 'Track real rankings and popularity for these keywords: free Searvia account at https://searvia.com, then `searvia login`.');

    const result = { score: Math.round(reports.reduce((sum, report) => sum + report.score, 0) / reports.length), reports, fixes, failing };
    if (failing.length) {
      context.out.result(result);
      throw new CliError(`Below --min-score ${minimum}: ${failing.join(', ')}.`, { exitCode: 3, details: { printed: true } });
    }
    return result;
  },
};
