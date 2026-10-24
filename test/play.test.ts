import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GooglePlay } from '../src/play/client.js';
import { releasePlay } from '../src/play/release.js';
import { json, mockFetch, noWait, rsaKey, tempDir, writeFiles } from './helpers.js';

const account = { client_email: 'ci@p.iam.gserviceaccount.com', private_key: rsaKey().privateKey, token_uri: 'https://oauth2.googleapis.com/token' };
const base = '/androidpublisher/v3/applications/com.example.app';

describe('Google Play', () => {
  beforeEach(() => noWait());

  it('gets a token, uploads the bundle resumably, updates the track and commits one edit', async () => {
    const dir = tempDir();
    const aab = join(dir, 'app.aab');
    const bytes = Buffer.from('a'.repeat(40));
    writeFileSync(aab, bytes);
    writeFiles(dir, {
      'meta/en-US/title.txt': 'Cebbin',
      'meta/en-US/short_description.txt': 'Budget planner',
      'meta/en-US/changelogs/42.txt': 'Faster charts',
      'meta/tr-TR/changelogs/default.txt': 'Daha hızlı grafikler',
    });
    let session = 0;
    const calls = mockFetch([
      ['POST', '/token', json({ access_token: 'ya29.token', expires_in: 3599 })],
      ['POST', `${base}/edits`, json({ id: 'edit1' })],
      ['GET', `${base}/edits/edit1/listings`, json({ listings: [{ language: 'en-US', title: 'Cebbin', shortDescription: 'Old short' }] })],
      ['PATCH', `${base}/edits/edit1/listings/en-US`, (call) => json(call.body)],
      ['POST', `/resumable/upload${base}/edits/edit1/bundles`, new Response(null, { status: 200, headers: { location: 'https://upload.example/session?upload_id=1' } })],
      [
        'PUT',
        /upload\.example\/session/,
        () => (++session === 1 ? new Response(null, { status: 308, headers: { range: 'bytes=0-9' } }) : json({ versionCode: 42, sha256: 'abc' })),
      ],
      ['PUT', `${base}/edits/edit1/tracks/production`, (call) => json(call.body)],
      ['POST', `${base}/edits/edit1:commit`, json({ id: 'edit1' })],
    ]);
    const play = new GooglePlay(account, 'com.example.app');
    const result = await releasePlay(play, {
      apply: true,
      track: 'production',
      aab,
      rollout: 20,
      metadataDir: join(dir, 'meta'),
      listings: { 'en-US': { title: 'Cebbin', short_description: 'Budget planner' } },
    });
    expect(result.versionCodes).toEqual([42]);

    const token = calls[0];
    const form = new URLSearchParams(String(token?.raw));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(form.get('assertion')?.split('.')).toHaveLength(3);
    expect(calls[1]?.headers.authorization).toBe('Bearer ya29.token');

    const start = calls.find((call) => call.path.startsWith('/resumable'));
    expect(start?.url).toContain('uploadType=resumable');
    expect(start?.headers).toMatchObject({ 'x-upload-content-type': 'application/octet-stream', 'x-upload-content-length': '40' });
    const puts = calls.filter((call) => call.url.includes('upload.example'));
    expect(puts.map((call) => call.headers['content-range'])).toEqual(['bytes 0-39/40', 'bytes 10-39/40']);

    expect(calls.find((call) => call.path.endsWith('/listings/en-US'))?.body).toEqual({ shortDescription: 'Budget planner' });
    expect(calls.find((call) => call.path.endsWith('/tracks/production'))?.body).toEqual({
      track: 'production',
      releases: [
        {
          versionCodes: ['42'],
          status: 'inProgress',
          userFraction: 0.2,
          releaseNotes: [
            { language: 'en-US', text: 'Faster charts' },
            { language: 'tr-TR', text: 'Daha hızlı grafikler' },
          ],
        },
      ],
    });
    const order = calls.map((call) => `${call.method} ${call.path.replace(base, '')}`);
    expect(order.at(-1)).toBe('POST /edits/edit1:commit');
    expect(order.indexOf('PUT /edits/edit1/tracks/production')).toBeGreaterThan(order.findIndex((entry) => entry.includes('upload.example') || entry.startsWith('PUT /session')));
  });

  it('dry run discards the edit and halts nothing', async () => {
    const calls = mockFetch([
      ['POST', '/token', json({ access_token: 't', expires_in: 3599 })],
      ['POST', `${base}/edits`, json({ id: 'e2' })],
      ['GET', `${base}/edits/e2/tracks/production`, json({ track: 'production', releases: [{ versionCodes: ['41'], status: 'inProgress', userFraction: 0.1 }] })],
      ['DELETE', `${base}/edits/e2`, new Response(null, { status: 204 })],
    ]);
    const result = await releasePlay(new GooglePlay(account, 'com.example.app'), { apply: false, track: 'production', rollout: 50, metadataDir: tempDir() });
    expect(result.steps.find((step) => step.step === 'rollout')?.detail).toContain('inProgress → inProgress 50%');
    expect(calls.at(-1)?.method).toBe('DELETE');
    expect(calls.some((call) => call.path.endsWith(':commit'))).toBe(false);
  });

  it('explains permission errors', async () => {
    mockFetch([
      ['POST', '/token', json({ access_token: 't', expires_in: 3599 })],
      ['POST', `${base}/edits`, json({ error: { code: 403, message: 'The caller does not have permission' } }, 403)],
    ]);
    await expect(new GooglePlay(account, 'com.example.app').insertEdit()).rejects.toMatchObject({ status: 403, hint: expect.stringContaining('ci@p.iam.gserviceaccount.com') });
  });
});
