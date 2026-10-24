import { describe, expect, it } from 'vitest';
import { analyze } from '../src/aso/density.js';
import { items, pack, review } from '../src/aso/rules.js';
import { words } from '../src/aso/words.js';
import { bytes } from '../src/core/util.js';

const rule = (result: ReturnType<typeof review>, name: string) => result.issues.filter((issue) => issue.rule === name);

describe('keyword field bytes', () => {
  it('counts Turkish letters as 2 bytes and CJK as 3', () => {
    expect(bytes('ç')).toBe(2);
    expect(bytes('ğış')).toBe(6);
    expect(bytes('家計簿')).toBe(9);
    expect(bytes('가계부')).toBe(9);
  });

  it('flags a Turkish keyword field over 100 bytes even when under 100 characters', () => {
    const keywords = 'gider,harcama,bütçe,tasarruf,cüzdan,ödeme,fatura,gelir,birikim,borç,kredi,döviz,çizelge,öğün';
    expect([...keywords].length).toBeLessThanOrEqual(100);
    expect(bytes(keywords)).toBeGreaterThan(100);
    const result = review({ title: 'Cebbin', subtitle: 'Kişisel finans', keywords }, { language: 'tr' });
    expect(rule(result, 'budget').some((issue) => issue.kind === 'error' && issue.message.includes('/100 bytes'))).toBe(true);
  });

  it('measures the 160 pool as characters + keyword bytes', () => {
    const result = review({ title: 'Kakeibo', subtitle: 'Budget', keywords: '家計簿,節約' }, { language: 'ja' });
    expect(result.used).toBe(7 + 6 + bytes('家計簿,節約'));
  });
});

describe('review', () => {
  it('finds repetition across fields and inside the keyword field', () => {
    const result = review({ title: 'Habit Tracker', subtitle: 'Daily habit goals', keywords: 'habit,goals,routine,routine' }, { language: 'en' });
    const messages = rule(result, 'repetition').map((issue) => issue.message);
    expect(messages.some((text) => text.includes('both the title and the subtitle'))).toBe(true);
    expect(messages.some((text) => text.includes('in the title and again'))).toBe(true);
    expect(messages.some((text) => text.includes('in the subtitle and again') && text.includes('goals'))).toBe(true);
    expect(messages.some((text) => text.includes('more than once') && text.includes('routine'))).toBe(true);
  });

  it('flags filler per language: "para" is filler in Spanish, a real word in Turkish', () => {
    expect(rule(review({ title: 'Ahorro', subtitle: 'Gastos', keywords: 'para,presupuesto' }, { language: 'es' }), 'filler')[0]?.words).toContain('para');
    expect(rule(review({ title: 'Cebbin', subtitle: 'Gider', keywords: 'para,bütçe' }, { language: 'tr' }), 'filler')).toHaveLength(0);
  });

  it('flags singular/plural twins, other brands, category words and comma spacing', () => {
    const result = review({ title: 'Recipe Box', subtitle: 'Cook dinner', keywords: 'recipes, meal,instagram,games' }, { language: 'en', avoid: ['instagram'] });
    expect(rule(result, 'singular')[0]?.words).toEqual(['recipes']);
    expect(rule(result, 'brand')[0]?.words).toEqual(['instagram']);
    expect(rule(result, 'category')[0]?.words).toEqual(['games']);
    expect(rule(result, 'format').some((issue) => issue.kind === 'error')).toBe(true);
  });

  it('treats an unspaced keyword inside the title as repetition (Japanese)', () => {
    const result = review({ title: '家計簿アプリ', subtitle: '節約', keywords: '家計簿,貯金' }, { language: 'ja' });
    expect(rule(result, 'repetition').some((issue) => issue.words.includes('家計簿'))).toBe(true);
  });

  it('reports overlap with other localizations of the storefront; brand words do not count', () => {
    const siblings = { 'en-GB': { title: 'Cebbin: Budget', subtitle: 'Expense tracker', keywords: 'money' } };
    const primary = review({ title: 'Cebbin: Bütçe', subtitle: 'Gider takibi', keywords: 'money,para' }, { siblings, primary: true, brand: ['Cebbin'], language: 'tr' });
    const extra = review({ title: 'Cebbin: Bütçe', subtitle: 'Gider takibi', keywords: 'money,para' }, { siblings, primary: false, brand: ['Cebbin'], language: 'tr' });
    expect(rule(primary, 'locales')[0]).toMatchObject({ kind: 'info', words: ['money'] });
    expect(rule(extra, 'locales')[0]).toMatchObject({ kind: 'warning', words: ['money'] });
  });

  it('scores 100 minus 12 per error and 5 per warning (per word up to 3)', () => {
    const perfect = review({
      title: 'Budget Planner Pro Edition X',
      subtitle: 'Expense tracker for families',
      keywords: 'money,spending,savings,finance,bills,wallet,income,debt,coupon,receipt,invoice,salary,tax,bank,cash,loan',
    });
    const penalty = perfect.issues.reduce((sum, issue) => sum + { error: 12, warning: 5, info: 0, good: 0 }[issue.kind] * Math.max(1, Math.min(3, issue.words.length)), 0);
    expect(perfect.score).toBe(Math.max(0, 100 - penalty));
    const clean = review(
      {
        title: 'Cebbin Budget Planner',
        subtitle: 'Expense tracker for families',
        keywords: 'money,spending,savings,finance,bills,wallet,income,debt,coupon,receipt,invoice,salary,tax',
      },
      { language: 'en' },
    );
    expect(clean.issues.filter((issue) => issue.kind === 'error')).toHaveLength(0);
  });

  it('splits items on commas and trims them', () => {
    expect(items(' A, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(words('Ödeme-Takibi, 2026!')).toEqual(['ödeme', 'takibi', '2026']);
  });
});

describe('pack', () => {
  it('drops wasted words and packs to ≤ 100 bytes in order', () => {
    const result = pack(
      { title: 'Budget Planner', subtitle: 'Expense tracker', keywords: 'budget, money,app,the,expenses,savings saving,money' },
      {
        tail: ['finance', 'bills', 'wallet', 'income', 'debt', 'coupon', 'receipt', 'invoice', 'salary', 'tax', 'bank', 'cash', 'loan', 'credit', 'payday', 'household'],
        language: 'en',
      },
    );
    expect(result.dropped).toEqual(expect.arrayContaining(['budget', 'app', 'the', 'expenses']));
    expect(result.keywords.split(',').slice(0, 2)).toEqual(['money', 'saving']);
    expect(result.keywords).not.toMatch(/savings/);
    expect(result.bytes).toBe(bytes(result.keywords));
    expect(result.bytes).toBeLessThanOrEqual(100);
    expect(result.keywords).not.toContain(' ');
  });

  it('puts lead words first and keeps unspaced items whole', () => {
    const result = pack({ title: '家計簿', subtitle: '節約', keywords: '貯金,家計簿,支出' }, { lead: ['予算'], language: 'ja' });
    expect(result.keywords).toBe('予算,貯金,支出');
    expect(result.dropped).toEqual(['家計簿']);
    expect(result.added).toEqual(['予算']);
  });

  it('counts Turkish multibyte words when packing', () => {
    const many = Array.from({ length: 30 }, (_, index) => `ödeme${index}`);
    const result = pack({ title: 'Cebbin', subtitle: 'Gider', keywords: '' }, { tail: many, language: 'tr' });
    expect(bytes(result.keywords)).toBeLessThanOrEqual(100);
    expect(result.notes.some((note) => note.includes('did not fit'))).toBe(true);
  });
});

describe('Play density', () => {
  it('warns on stuffing above 3% and repeated short-description phrases', () => {
    const full = `${'Track every expense. '.repeat(10)}${'Plan the month with simple charts and goals. '.repeat(5)}`;
    const result = analyze({ title: 'Budget Budget', short_description: 'expense expense expense tracker', full_description: full }, ['expense', 'budget planner'], 'en');
    expect(result.warnings.some((warning) => warning.field === 'full_description' && warning.message.includes('“expense”'))).toBe(true);
    expect(result.warnings.some((warning) => warning.field === 'short_description')).toBe(true);
    expect(result.warnings.some((warning) => warning.field === 'title')).toBe(true);
    expect(result.missing).toEqual(['budget planner']);
    expect(result.keywords[0]?.early).toBe(true);
  });
});
