import { beforeEach, describe, expect, it } from 'vitest';
import { resolveApp } from '../src/apple/app.js';
import { AppStoreConnect } from '../src/apple/client.js';
import { applyPush, loadRemoteListing, planPush } from '../src/apple/listing.js';
import { ecKey, json, mockFetch, noWait, resource } from './helpers.js';

const key = ecKey();
const client = () => new AppStoreConnect({ keyId: 'KEY', issuerId: 'ISS', privateKey: key.privateKey });
const page = (data: unknown[]) => ({ data, links: {} });

function listingRoutes(options: { editable?: boolean } = {}) {
  const versions = [
    resource('appStoreVersions', 'v-live', { versionString: '1.0', appVersionState: 'READY_FOR_DISTRIBUTION', createdDate: '2026-01-01T00:00:00Z' }),
    ...(options.editable === false
      ? []
      : [resource('appStoreVersions', 'v-edit', { versionString: '1.1', appVersionState: 'PREPARE_FOR_SUBMISSION', createdDate: '2026-02-01T00:00:00Z' })]),
  ];
  return [
    ['GET', '/v1/apps', page([resource('apps', '123', { name: 'Cebbin', bundleId: 'com.example.cebbin' })])],
    ['GET', '/v1/apps/123/appStoreVersions', page(versions)],
    ['GET', '/v1/apps/123/appInfos', page([resource('appInfos', 'info-1', { state: options.editable === false ? 'READY_FOR_DISTRIBUTION' : 'PREPARE_FOR_SUBMISSION' })])],
    [
      'GET',
      '/v1/appStoreVersions/v-edit/appStoreVersionLocalizations',
      page([resource('appStoreVersionLocalizations', 'loc-edit-en', { locale: 'en-US', keywords: 'old,words', description: 'Desc', promotionalText: 'Promo' })]),
    ],
    [
      'GET',
      '/v1/appStoreVersions/v-live/appStoreVersionLocalizations',
      page([resource('appStoreVersionLocalizations', 'loc-live-en', { locale: 'en-US', keywords: 'old,words', description: 'Desc', promotionalText: 'Promo' })]),
    ],
    ['GET', '/v1/appInfos/info-1/appInfoLocalizations', page([resource('appInfoLocalizations', 'info-en', { locale: 'en-US', name: 'Cebbin', subtitle: 'Budget' })])],
    ['PATCH', /\/v1\/appStoreVersionLocalizations\//, (call: { body: unknown }) => json({ data: (call.body as { data: unknown }).data })],
    ['PATCH', /\/v1\/appInfoLocalizations\//, (call: { body: unknown }) => json({ data: (call.body as { data: unknown }).data })],
    ['POST', '/v1/appStoreVersionLocalizations', json({ data: resource('appStoreVersionLocalizations', 'new-loc') }, 201)],
    ['POST', '/v1/appInfoLocalizations', json({ data: resource('appInfoLocalizations', 'new-info') }, 201)],
  ] as const;
}

describe('App Store Connect listing push', () => {
  beforeEach(() => noWait());

  it('sends a bearer JWT and resolves the app by bundle id', async () => {
    const calls = mockFetch(listingRoutes() as never);
    const app = await resolveApp(client(), { bundleId: 'com.example.cebbin' });
    expect(app).toMatchObject({ id: '123', name: 'Cebbin' });
    expect(calls[0]?.url).toContain('filter%5BbundleId%5D=com.example.cebbin');
    expect(calls[0]?.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('diffs and writes version + info attributes with the right payloads', async () => {
    const calls = mockFetch(listingRoutes() as never);
    const asc = client();
    const app = await resolveApp(asc, { bundleId: 'com.example.cebbin' });
    const remote = await loadRemoteListing(asc, app);
    expect(remote.version?.id).toBe('v-edit');
    const plan = planPush(remote, { 'en-US': { keywords: 'new,words', subtitle: 'Budget planner', description: 'Desc' }, 'de-DE': { name: 'Cebbin', keywords: 'geld' } });
    expect(plan.changes.map((change) => `${change.locale}:${change.field}`)).toEqual(['en-US:subtitle', 'en-US:keywords', 'de-DE:name', 'de-DE:keywords']);
    expect(plan.missingLocales).toEqual(['de-DE']);
    await expect(applyPush(asc, remote, plan, {})).rejects.toMatchObject({ message: expect.stringContaining('de-DE'), hint: expect.stringContaining('--create-locales') });

    calls.length = 0;
    await applyPush(asc, remote, plan, { createLocales: true });
    const writes = calls.filter((call) => call.method !== 'GET').map((call) => ({ method: call.method, path: call.path, body: call.body }));
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: '/v1/appStoreVersionLocalizations/loc-edit-en',
        body: { data: { type: 'appStoreVersionLocalizations', id: 'loc-edit-en', attributes: { keywords: 'new,words' } } },
      },
      { method: 'PATCH', path: '/v1/appInfoLocalizations/info-en', body: { data: { type: 'appInfoLocalizations', id: 'info-en', attributes: { subtitle: 'Budget planner' } } } },
      {
        method: 'POST',
        path: '/v1/appStoreVersionLocalizations',
        body: {
          data: {
            type: 'appStoreVersionLocalizations',
            attributes: { locale: 'de-DE', keywords: 'geld' },
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'v-edit' } } },
          },
        },
      },
      {
        method: 'POST',
        path: '/v1/appInfoLocalizations',
        body: { data: { type: 'appInfoLocalizations', attributes: { locale: 'de-DE', name: 'Cebbin' }, relationships: { appInfo: { data: { type: 'appInfos', id: 'info-1' } } } } },
      },
    ]);
  });

  it('writes promotional text to both the editable and the live version', async () => {
    const calls = mockFetch(listingRoutes() as never);
    const asc = client();
    const remote = await loadRemoteListing(asc, await resolveApp(asc, { bundleId: 'com.example.cebbin' }));
    const plan = planPush(remote, { 'en-US': { promotional_text: 'Now with charts' } });
    await applyPush(asc, remote, plan, {});
    expect(calls.filter((call) => call.method === 'PATCH').map((call) => call.path)).toEqual([
      '/v1/appStoreVersionLocalizations/loc-edit-en',
      '/v1/appStoreVersionLocalizations/loc-live-en',
    ]);
  });

  it('refuses version fields without an editable version but allows promotional text', async () => {
    const calls = mockFetch(listingRoutes({ editable: false }) as never);
    const asc = client();
    const remote = await loadRemoteListing(asc, await resolveApp(asc, { bundleId: 'com.example.cebbin' }));
    await expect(applyPush(asc, remote, planPush(remote, { 'en-US': { keywords: 'x' } }), {})).rejects.toThrow(/no editable version/);
    await applyPush(asc, remote, planPush(remote, { 'en-US': { promotional_text: 'Live promo' } }), {});
    expect(calls.filter((call) => call.method === 'PATCH').map((call) => call.path)).toEqual(['/v1/appStoreVersionLocalizations/loc-live-en']);
  });

  it('turns API errors into readable messages with hints', async () => {
    mockFetch([['GET', '/v1/apps/999', json({ errors: [{ status: '403', code: 'FORBIDDEN_ERROR', title: 'Forbidden', detail: 'The API key does not have access.' }] }, 403)]]);
    await expect(resolveApp(client(), { appId: '999' })).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('does not have access'),
      hint: expect.stringContaining('App Manager'),
    });
  });
});
