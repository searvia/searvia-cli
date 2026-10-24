import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Waiting is injectable so tests (and `--no-wait`) never sleep for real. */
export const timing = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  now: (): number => Date.now(),
};

/** Unicode code points (what Apple and Google call "characters"). */
export function chars(text: string | null | undefined): number {
  return [...(text ?? '')].length;
}

/** UTF-8 bytes (the App Store keyword field limit is 100 bytes). */
export function bytes(text: string | null | undefined): number {
  return Buffer.byteLength(text ?? '', 'utf8');
}

export function md5(data: Buffer | string): string {
  return createHash('md5').update(data).digest('hex');
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function md5File(path: string): Promise<string> {
  return md5(await readFile(path));
}

export function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

/** Natural sort ("2.png" before "10.png"), the order screenshots are uploaded in. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Polls `check` until it returns a value (not undefined) or the timeout passes. */
export async function poll<T>(
  check: () => Promise<T | undefined>,
  options: { intervalMs: number; timeoutMs: number; onWait?: (elapsedMs: number) => void },
): Promise<T | undefined> {
  const started = timing.now();
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    const elapsed = timing.now() - started;
    if (elapsed >= options.timeoutMs) return undefined;
    options.onWait?.(elapsed);
    await timing.sleep(options.intervalMs);
  }
}

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!match) throw new Error(`Invalid duration "${text}" (use e.g. 90s, 30m, 2h).`);
  const value = Number(match[1]);
  const unit = match[2] ?? 'm';
  return value * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[unit as 'ms' | 's' | 'm' | 'h'];
}
