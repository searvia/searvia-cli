/**
 * Word matching in store text. Apple indexes the single words of the title, subtitle and keyword field and combines
 * them: a search is covered when each of its words appears somewhere in those fields (order does not matter).
 * Descriptions (and Google Play's long text) are matched as phrases: the words must be adjacent.
 */

const SEPARATOR = /[^\p{L}\p{N}\p{M}]+/u;

/** Lowercase words; punctuation and commas separate, combining marks stay inside words (Hindi, Tamil…). */
export function words(text: string | null | undefined): string[] {
  const value = (text ?? '').trim().toLowerCase();
  if (value === '') return [];
  return value.split(SEPARATOR).filter((word) => word !== '');
}

export function covers(fieldWords: string[], keyword: string): boolean {
  const needed = words(keyword);
  return needed.length > 0 && needed.every((word) => fieldWords.includes(word));
}

export function phrase(text: string | null | undefined, keyword: string): boolean {
  const needed = words(keyword);
  return needed.length > 0 && ` ${words(text).join(' ')} `.includes(` ${needed.join(' ')} `);
}

/** Languages written without spaces (Chinese, Japanese, Korean, Thai): words match as substrings. */
export function unspaced(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u.test(text);
}
