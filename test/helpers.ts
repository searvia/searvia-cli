import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { vi } from 'vitest';
import type { Resource } from '../src/apple/client.js';
import { timing } from '../src/core/util.js';

export interface Call {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  raw?: unknown;
}

type Responder = (call: Call, index: number) => Response | Promise<Response>;
type Fixed = Response | Record<string, unknown> | unknown[] | null;
export type Route = [method: string, pattern: string | RegExp, respond: Responder | Fixed];

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * Stubs global fetch with a router. Patterns match the URL path (string = exact path, RegExp = anywhere in the URL).
 * Unmatched requests fail the test loudly. Returns the list of calls in order.
 */
export function mockFetch(routes: Route[]): Call[] {
  const calls: Call[] = [];
  const hits = new Map<Route, number>();
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    let body: unknown = init.body;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: Call = { method: init.method ?? 'GET', url: url.toString(), path: url.pathname, headers, body, raw: init.body };
    calls.push(call);
    const route = routes.find(([method, pattern]) => method === call.method && (typeof pattern === 'string' ? pattern === url.pathname : pattern.test(url.toString())));
    if (!route) throw new Error(`Unexpected request ${call.method} ${call.url}`);
    const count = hits.get(route) ?? 0;
    hits.set(route, count + 1);
    const respond = route[2];
    if (typeof respond === 'function') return (respond as Responder)(call, count);
    if (respond instanceof Response) return respond.clone();
    return json(respond);
  });
  return calls;
}

export function noWait(): void {
  let now = 1_700_000_000_000;
  vi.spyOn(timing, 'sleep').mockImplementation(async (ms: number) => {
    now += ms;
  });
  vi.spyOn(timing, 'now').mockImplementation(() => now);
}

export function ecKey(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

export function rsaKey(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'searvia-test-'));
}

export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** A PNG header (signature + IHDR) of the given size; enough for size detection and checksums. */
export function png(width: number, height: number, colorType = 2, filler = 'x'): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = colorType;
  return Buffer.concat([header, Buffer.from(filler.repeat(64))]);
}

/** A ZIP archive (deflate) built in memory, for .ipa tests. */
export function zip(entries: Record<string, Buffer | string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const compressed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + compressed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function resource(type: string, id: string, attributes: Record<string, unknown> = {}, relationships?: Resource['relationships']): Resource {
  return { type, id, attributes, ...(relationships ? { relationships } : {}) };
}
