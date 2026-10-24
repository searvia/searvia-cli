import { describe, expect, it } from 'vitest';
import { auditApple, auditPlay, fixApple, relevantStorefronts } from '../src/aso/audit.js';

describe('auditApple', () => {
  it('checks overlap only where locales share a storefront (Turkey indexes en-GB and tr)', () => {
    const report = auditApple(
      {
        tr: { name: 'Cebbin: Bütçe', subtitle: 'Gider takibi', keywords: 'money,para' },
        'en-GB': { name: 'Cebbin: Budget', subtitle: 'Expense tracker', keywords: 'money,savings' },
        ja: { name: '家計簿', subtitle: '節約', keywords: 'money' },
      },
      { brand: ['Cebbin'] },
    );
    expect(relevantStorefronts(['tr', 'en-GB', 'ja'])).toEqual(expect.arrayContaining(['TR', 'CY']));
    const tr = report.locales.find((item) => item.locale === 'tr');
    const ja = report.locales.find((item) => item.locale === 'ja');
    expect(tr?.issues.find((issue) => issue.rule === 'locales')?.words).toEqual(['money']);
    // Japan indexes ja + en-US, not en-GB: no overlap check for ja.
    expect(ja?.issues.some((issue) => issue.rule === 'locales')).toBe(false);
    expect(report.score).toBe(Math.round(report.locales.reduce((sum, item) => sum + item.score, 0) / 3));
  });

  it('adds copy limits (promotional text 170)', () => {
    const report = auditApple({ 'en-US': { name: 'A', subtitle: 'B', keywords: 'c', promotional_text: 'x'.repeat(171) } });
    expect(report.locales[0]?.issues[0]).toMatchObject({ kind: 'error', rule: 'limit' });
  });

  it('fix packs every locale', () => {
    const fixed = fixApple({ 'en-US': { name: 'Habit Tracker', subtitle: 'Daily goals', keywords: 'habit, routine,app' } });
    expect(fixed['en-US']?.keywords).toBe('routine');
  });
});

describe('auditPlay', () => {
  it('flags limits and stuffing', () => {
    const report = auditPlay({ 'en-US': { title: 'x'.repeat(31), short_description: 'Budget budget budget planner', full_description: 'Budget app.' } }, { keywords: ['budget'] });
    const issues = report.locales[0]?.issues ?? [];
    expect(issues.some((issue) => issue.rule === 'limit')).toBe(true);
    expect(issues.some((issue) => issue.rule === 'stuffing')).toBe(true);
    expect(report.locales[0]?.score).toBeLessThan(90);
  });
});
