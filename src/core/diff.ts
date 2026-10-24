import type { Output } from './output.js';

export interface FieldChange {
  /** e.g. "ios", "android" */
  platform: string;
  locale: string;
  field: string;
  before: string | null;
  after: string | null;
}

/** Field values compared the way the stores store them: trimmed, CRLF normalised, empty = missing. */
export function normalise(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.replace(/\r\n?/g, '\n').trim();
  return text === '' ? null : text;
}

export function changed(before: string | null | undefined, after: string | null | undefined): boolean {
  return normalise(before) !== normalise(after);
}

/** Line diff (LCS) for multi-line text such as descriptions. */
export function lineDiff(before: string, after: string): Array<{ op: ' ' | '-' | '+'; line: string }> {
  const a = before.split('\n');
  const b = after.split('\n');
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[] = new Array(rows * cols).fill(0);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = a[i] === b[j] ? (table[(i + 1) * cols + j + 1] as number) + 1 : Math.max(table[(i + 1) * cols + j] as number, table[i * cols + j + 1] as number);
    }
  }
  const out: Array<{ op: ' ' | '-' | '+'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', line: a[i] as string });
      i++;
      j++;
    } else if ((table[(i + 1) * cols + j] as number) >= (table[i * cols + j + 1] as number)) out.push({ op: '-', line: a[i++] as string });
    else out.push({ op: '+', line: b[j++] as string });
  }
  while (i < a.length) out.push({ op: '-', line: a[i++] as string });
  while (j < b.length) out.push({ op: '+', line: b[j++] as string });
  return out;
}

export function renderChanges(out: Output, changes: FieldChange[], options: { context?: number } = {}): void {
  const context = options.context ?? 1;
  for (const change of changes) {
    const label = change.before === null ? 'new' : change.after === null ? 'cleared' : 'changed';
    out.log(`${out.paint('bold', `${change.platform} ${change.locale} › ${change.field}`)} ${out.paint('gray', `(${label})`)}`);
    const rows =
      change.before === null
        ? (change.after ?? '').split('\n').map((line) => ({ op: '+' as const, line }))
        : change.after === null
          ? change.before.split('\n').map((line) => ({ op: '-' as const, line }))
          : lineDiff(change.before, change.after);
    const keep = rows.map((row, index) => row.op !== ' ' || rows.slice(Math.max(0, index - context), index + context + 1).some((near) => near.op !== ' '));
    let skipped = false;
    rows.forEach((row, index) => {
      if (!keep[index]) {
        if (!skipped) out.log(out.paint('gray', '  …'));
        skipped = true;
        return;
      }
      skipped = false;
      if (row.op === '-') out.log(out.paint('red', `  - ${row.line}`));
      else if (row.op === '+') out.log(out.paint('green', `  + ${row.line}`));
      else out.log(out.paint('gray', `    ${row.line}`));
    });
  }
}
