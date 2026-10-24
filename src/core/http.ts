import { CliError } from './errors.js';
import type { Output } from './output.js';
import { timing } from './util.js';

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Retries for network errors, 429 and 5xx (default 4). */
  retries?: number;
  /** Status codes the caller handles itself (never retried, never thrown). */
  accept?: number[];
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * fetch with retries and exponential backoff (2^n s + jitter, honouring Retry-After), as both Apple and Google ask
 * clients to do for rate limits and transient errors. Always calls `globalThis.fetch` so tests can stub it.
 */
export async function httpRequest(request: HttpRequest, options: { service: string; out?: Output }): Promise<Response> {
  const retries = request.retries ?? 4;
  let attempt = 0;

  for (;;) {
    options.out?.debug(`${request.method} ${redact(request.url)}`);
    let response: Response;
    try {
      response = await globalThis.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body as NonNullable<Parameters<typeof fetch>[1]>['body'],
      });
    } catch (error) {
      if (attempt >= retries) {
        throw new CliError(`Could not reach ${options.service} (${(error as Error).message}).`, { hint: 'Check the network connection and try again.' });
      }
      await backoff(attempt++, null);
      continue;
    }

    if (request.accept?.includes(response.status)) return response;
    if (RETRY_STATUS.has(response.status) && attempt < retries) {
      options.out?.debug(`${response.status}, retrying`);
      await response.arrayBuffer().catch(() => undefined);
      await backoff(attempt++, response.headers.get('retry-after'));
      continue;
    }
    return response;
  }
}

async function backoff(attempt: number, retryAfter: string | null): Promise<void> {
  const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : 2 ** attempt;
  await timing.sleep(Math.min(seconds, 60) * 1000 + Math.floor(Math.random() * 500));
}

/** Upload URLs carry signatures in the query string; never print them. */
export function redact(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : `${url.slice(0, index)}?…`;
}

export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
