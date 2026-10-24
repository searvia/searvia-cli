import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppStoreConnect } from '../src/apple/client.js';
import { scanScreenshots, syncScreenshots } from '../src/apple/screenshots.js';
import { ecKey, json, mockFetch, noWait, png, resource, tempDir, writeFiles } from './helpers.js';

const key = ecKey();

describe('App Store screenshots', () => {
  beforeEach(() => noWait());

  it('validates sizes, alpha and the 10-per-set limit', () => {
    const dir = tempDir();
    writeFiles(dir, {
      'en-US/01.png': png(1320, 2868),
      'en-US/02.png': png(1000, 1000),
      'en-US/03.png': png(1290, 2796, 6),
      ...Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`tr/${String(index).padStart(2, '0')}.png`, png(1242, 2688, 2, String(index))])),
    });
    const scan = scanScreenshots(dir);
    expect(scan.errors.join('\n')).toMatch(/02\.png: 1000×1000 matches no/);
    expect(scan.errors.join('\n')).toMatch(/03\.png: has an alpha channel/);
    expect(scan.errors.join('\n')).toMatch(/tr APP_IPHONE_65: 11 screenshots/);
    expect(scan.locales['en-US']?.APP_IPHONE_67?.map((shot) => shot.file)).toEqual(['01.png', '03.png']);
  });

  it('reserves, uploads each part with its headers, commits with MD5 and orders the set', async () => {
    const dir = tempDir();
    writeFiles(dir, { 'en-US/01.png': png(1320, 2868, 2, 'a'), 'en-US/02.png': png(1320, 2868, 2, 'b') });
    const scan = scanScreenshots(dir);
    const files = ['01.png', '02.png'].map((name) => readFileSync(join(dir, 'en-US', name)));
    let reserved = 0;
    const calls = mockFetch([
      ['GET', '/v1/appStoreVersionLocalizations/loc-en/appScreenshotSets', { data: [resource('appScreenshotSets', 'set-old', { screenshotDisplayType: 'APP_IPHONE_67' })] }],
      ['GET', '/v1/appScreenshotSets/set-old/appScreenshots', { data: [resource('appScreenshots', 'old-1', { sourceFileChecksum: 'different' })] }],
      ['DELETE', '/v1/appScreenshots/old-1', new Response(null, { status: 204 })],
      [
        'POST',
        '/v1/appScreenshots',
        (call) => {
          const size = (call.body as { data: { attributes: { fileSize: number } } }).data.attributes.fileSize;
          const id = `shot-${++reserved}`;
          const half = Math.floor(size / 2);
          return json(
            {
              data: resource('appScreenshots', id, {
                uploadOperations: [
                  { method: 'PUT', url: `https://upload.example/${id}?part=1`, offset: 0, length: half, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] },
                  { method: 'PUT', url: `https://upload.example/${id}?part=2`, offset: half, length: size - half, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] },
                ],
              }),
            },
            201,
          );
        },
      ],
      ['PUT', /upload\.example/, new Response(null, { status: 200 })],
      ['PATCH', /\/v1\/appScreenshots\/shot-\d$/, (call) => json({ data: (call.body as { data: unknown }).data })],
      [
        'GET',
        /\/v1\/appScreenshots\/shot-\d$/,
        (call, index) =>
          json({ data: resource('appScreenshots', call.path.split('/').pop() as string, { assetDeliveryState: { state: index < 1 ? 'UPLOAD_COMPLETE' : 'COMPLETE' } }) }),
      ],
      ['PATCH', '/v1/appScreenshotSets/set-old/relationships/appScreenshots', new Response(null, { status: 204 })],
    ]);
    const client = new AppStoreConnect({ keyId: 'K', issuerId: 'I', privateKey: key.privateKey });
    const plans = await syncScreenshots(client, [resource('appStoreVersionLocalizations', 'loc-en', { locale: 'en-US' })], scan.locales, { apply: true });
    expect(plans).toEqual([{ locale: 'en-US', type: 'APP_IPHONE_67', action: 'replace', local: 2, remote: 1 }]);

    const reserve = calls.find((call) => call.method === 'POST');
    expect(reserve?.body).toEqual({
      data: {
        type: 'appScreenshots',
        attributes: { fileName: '01.png', fileSize: files[0]?.length },
        relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: 'set-old' } } },
      },
    });

    const parts = calls.filter((call) => call.method === 'PUT' && call.url.includes('shot-1'));
    expect(parts.map((call) => call.headers['content-type'])).toEqual(['image/png', 'image/png']);
    expect(parts[0]?.headers.authorization).toBeUndefined();
    expect(Buffer.concat(parts.map((call) => Buffer.from(call.raw as Uint8Array)))).toEqual(files[0]);

    const commit = calls.find((call) => call.method === 'PATCH' && call.path === '/v1/appScreenshots/shot-1');
    expect(commit?.body).toEqual({
      data: {
        type: 'appScreenshots',
        id: 'shot-1',
        attributes: {
          uploaded: true,
          sourceFileChecksum: createHash('md5')
            .update(files[0] as Buffer)
            .digest('hex'),
        },
      },
    });

    const order = calls.find((call) => call.path.endsWith('/relationships/appScreenshots'));
    expect(order?.body).toEqual({
      data: [
        { type: 'appScreenshots', id: 'shot-1' },
        { type: 'appScreenshots', id: 'shot-2' },
      ],
    });
    const sequence = calls.map((call) => `${call.method} ${call.path}`);
    expect(sequence.indexOf('DELETE /v1/appScreenshots/old-1')).toBeLessThan(sequence.indexOf('POST /v1/appScreenshots'));
  });

  it('skips a set whose checksums already match', async () => {
    const dir = tempDir();
    writeFiles(dir, { 'en-US/01.png': png(1320, 2868) });
    const scan = scanScreenshots(dir);
    const checksum = scan.locales['en-US']?.APP_IPHONE_67?.[0]?.checksum;
    const calls = mockFetch([
      ['GET', '/v1/appStoreVersionLocalizations/loc-en/appScreenshotSets', { data: [resource('appScreenshotSets', 'set', { screenshotDisplayType: 'APP_IPHONE_67' })] }],
      ['GET', '/v1/appScreenshotSets/set/appScreenshots', { data: [resource('appScreenshots', 's1', { sourceFileChecksum: checksum })] }],
    ]);
    const client = new AppStoreConnect({ keyId: 'K', issuerId: 'I', privateKey: key.privateKey });
    const plans = await syncScreenshots(client, [resource('appStoreVersionLocalizations', 'loc-en', { locale: 'en-US' })], scan.locales, { apply: true });
    expect(plans[0]?.action).toBe('unchanged');
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });
});
