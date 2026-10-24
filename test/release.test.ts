import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { uploadBuild } from '../src/apple/build.js';
import { AppStoreConnect } from '../src/apple/client.js';
import { releaseIos } from '../src/apple/release.js';
import { ecKey, json, mockFetch, noWait, resource, tempDir } from './helpers.js';

const key = ecKey();
const client = () => new AppStoreConnect({ keyId: 'K', issuerId: 'I', privateKey: key.privateKey });
const notFound = () => json({ errors: [{ status: '404', code: 'NOT_FOUND', title: 'Not found', detail: 'none' }] }, 404);
const echo = (call: { body: unknown }) => json({ data: (call.body as { data: unknown }).data });

describe('release (App Store)', () => {
  beforeEach(() => noWait());

  it('runs every step in order and submits through reviewSubmissions', async () => {
    const calls = mockFetch([
      [
        'GET',
        '/v1/apps/123/appStoreVersions',
        { data: [resource('appStoreVersions', 'v-edit', { versionString: '1.1', appVersionState: 'PREPARE_FOR_SUBMISSION', createdDate: '2026-02-01' })] },
      ],
      ['GET', '/v1/apps/123/appInfos', { data: [resource('appInfos', 'info-1', { state: 'PREPARE_FOR_SUBMISSION' })] }],
      ['GET', '/v1/appStoreVersions/v-edit/appStoreVersionLocalizations', { data: [resource('appStoreVersionLocalizations', 'loc-en', { locale: 'en-US', keywords: 'old' })] }],
      ['GET', '/v1/appInfos/info-1/appInfoLocalizations', { data: [resource('appInfoLocalizations', 'info-en', { locale: 'en-US', name: 'Cebbin' })] }],
      ['PATCH', '/v1/appStoreVersionLocalizations/loc-en', echo],
      [
        'GET',
        '/v1/builds',
        (_call, index) => json({ data: [resource('builds', 'b1', { version: '7', processingState: index === 0 ? 'PROCESSING' : 'VALID', usesNonExemptEncryption: null })] }),
      ],
      ['PATCH', '/v1/builds/b1', echo],
      ['GET', '/v1/appStoreVersions/v-edit/build', { data: null }],
      ['PATCH', '/v1/appStoreVersions/v-edit/relationships/build', new Response(null, { status: 204 })],
      ['GET', '/v1/appStoreVersions/v-edit/appStoreReviewDetail', notFound],
      ['POST', '/v1/appStoreReviewDetails', json({ data: resource('appStoreReviewDetails', 'rd1') }, 201)],
      ['GET', '/v1/appInfos/info-1/ageRatingDeclaration', { data: resource('ageRatingDeclarations', 'age-1') }],
      ['PATCH', '/v1/ageRatingDeclarations/age-1', echo],
      ['PATCH', '/v1/appStoreVersions/v-edit', echo],
      ['GET', '/v1/appStoreVersions/v-edit/appStoreVersionPhasedRelease', notFound],
      ['POST', '/v1/appStoreVersionPhasedReleases', json({ data: resource('appStoreVersionPhasedReleases', 'pr1') }, 201)],
      ['GET', '/v1/reviewSubmissions', { data: [] }],
      ['POST', '/v1/reviewSubmissions', json({ data: resource('reviewSubmissions', 'rs1', { state: 'READY_FOR_REVIEW' }) }, 201)],
      ['GET', '/v1/reviewSubmissions/rs1/items', { data: [] }],
      ['POST', '/v1/reviewSubmissionItems', json({ data: resource('reviewSubmissionItems', 'item1') }, 201)],
      ['PATCH', '/v1/reviewSubmissions/rs1', json({ data: resource('reviewSubmissions', 'rs1', { state: 'WAITING_FOR_REVIEW' }) })],
    ]);

    const outcome = await releaseIos(
      client(),
      { id: '123', name: 'Cebbin', bundleId: 'com.example.cebbin' },
      {
        usesNonExemptEncryption: false,
        review: { firstName: 'Ada', lastName: 'Lovelace', email: 'review@example.com', phone: '+1 555 0100', demoUser: 'demo@example.com' },
        ageRating: { gambling: false, violenceCartoonOrFantasy: 'NONE' },
        releaseType: 'AFTER_APPROVAL',
        phasedRelease: true,
      },
      {
        apply: true,
        versionString: '1.1',
        buildNumber: '7',
        metadata: { locales: { 'en-US': { keywords: 'new,words' } }, review: {} },
        submit: true,
        waitTimeoutMs: 3_600_000,
        demoPassword: 'secret',
      },
    );

    expect(outcome.steps.map((step) => `${step.step}:${step.status}`)).toEqual([
      'version:unchanged',
      'metadata:done',
      'screenshots:skipped',
      'build processing:done',
      'export compliance:done',
      'attach build:done',
      'app review information:done',
      'age rating:done',
      'release options:done',
      'phased release:done',
      'submit for review:done',
    ]);
    const writes = calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`);
    expect(writes).toEqual([
      'PATCH /v1/appStoreVersionLocalizations/loc-en',
      'PATCH /v1/builds/b1',
      'PATCH /v1/appStoreVersions/v-edit/relationships/build',
      'POST /v1/appStoreReviewDetails',
      'PATCH /v1/ageRatingDeclarations/age-1',
      'PATCH /v1/appStoreVersions/v-edit',
      'POST /v1/appStoreVersionPhasedReleases',
      'POST /v1/reviewSubmissions',
      'POST /v1/reviewSubmissionItems',
      'PATCH /v1/reviewSubmissions/rs1',
    ]);
    const body = (path: string) => calls.find((call) => call.method !== 'GET' && call.path === path)?.body as { data: Record<string, unknown> };
    expect(body('/v1/builds/b1').data.attributes).toEqual({ usesNonExemptEncryption: false });
    expect(body('/v1/appStoreVersions/v-edit/relationships/build')).toEqual({ data: { type: 'builds', id: 'b1' } });
    expect(body('/v1/appStoreReviewDetails').data.attributes).toMatchObject({
      contactFirstName: 'Ada',
      demoAccountName: 'demo@example.com',
      demoAccountPassword: 'secret',
      demoAccountRequired: true,
    });
    expect(body('/v1/appStoreVersionPhasedReleases').data.attributes).toEqual({ phasedReleaseState: 'INACTIVE' });
    expect(body('/v1/reviewSubmissionItems').data.relationships).toEqual({
      reviewSubmission: { data: { type: 'reviewSubmissions', id: 'rs1' } },
      appStoreVersion: { data: { type: 'appStoreVersions', id: 'v-edit' } },
    });
    expect(body('/v1/reviewSubmissions/rs1').data.attributes).toEqual({ submitted: true });
    expect(calls.filter((call) => call.path === '/v1/builds')).toHaveLength(2);
    expect(outcome.manual[0]?.url).toBe('https://appstoreconnect.apple.com/apps/123/distribution/privacy');
  });

  it('dry run only reads', async () => {
    const calls = mockFetch([
      ['GET', '/v1/apps/123/appStoreVersions', { data: [resource('appStoreVersions', 'v-live', { versionString: '1.0', appVersionState: 'READY_FOR_DISTRIBUTION' })] }],
      ['GET', '/v1/appStoreVersions/v-live/appStoreVersionPhasedRelease', notFound],
    ]);
    const outcome = await releaseIos(client(), { id: '123', name: 'Cebbin', bundleId: 'x' }, {}, { apply: false, versionString: '1.1', submit: true, waitTimeoutMs: 1000 });
    expect(outcome.steps[0]).toMatchObject({ step: 'version', status: 'planned' });
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('refuses to submit while another submission is in review', async () => {
    mockFetch([
      ['GET', '/v1/apps/123/appStoreVersions', { data: [resource('appStoreVersions', 'v-edit', { versionString: '1.1', appVersionState: 'PREPARE_FOR_SUBMISSION' })] }],
      [
        'GET',
        '/v1/reviewSubmissions',
        { data: [resource('reviewSubmissions', 'rs0', { state: 'IN_REVIEW' }, { appStoreVersionForReview: { data: { type: 'appStoreVersions', id: 'other' } } })] },
      ],
      ['GET', '/v1/builds', { data: [resource('builds', 'b1', { version: '7', processingState: 'VALID', usesNonExemptEncryption: false })] }],
      ['GET', '/v1/appStoreVersions/v-edit/build', { data: resource('builds', 'b1') }],
    ]);
    await expect(releaseIos(client(), { id: '123', name: 'A', bundleId: 'x' }, {}, { apply: true, versionString: '1.1', submit: true, waitTimeoutMs: 1000 })).rejects.toMatchObject(
      { hint: expect.stringContaining('submit --cancel') },
    );
  });
});

describe('build upload (App Store Connect API)', () => {
  beforeEach(() => noWait());

  it('creates the upload, reserves the file, uploads parts, commits the MD5 and waits for COMPLETE', async () => {
    const dir = tempDir();
    const path = join(dir, 'App.ipa');
    const data = Buffer.from('0123456789abcdefghij');
    writeFileSync(path, data);
    const calls = mockFetch([
      ['POST', '/v1/buildUploads', json({ data: resource('buildUploads', 'bu1') }, 201)],
      [
        'POST',
        '/v1/buildUploadFiles',
        json(
          {
            data: resource('buildUploadFiles', 'f1', {
              uploadOperations: [
                { method: 'PUT', url: 'https://upload.example/1', offset: 0, length: 12, requestHeaders: [{ name: 'Content-Type', value: 'application/octet-stream' }] },
                { method: 'PUT', url: 'https://upload.example/2', offset: 12, length: 8, requestHeaders: [] },
              ],
            }),
          },
          201,
        ),
      ],
      ['PUT', /upload\.example/, new Response(null, { status: 200 })],
      ['PATCH', '/v1/buildUploadFiles/f1', echo],
      [
        'GET',
        '/v1/buildUploads/bu1',
        (_call, index) =>
          json({
            data: resource(
              'buildUploads',
              'bu1',
              { state: { state: index < 2 ? 'PROCESSING' : 'COMPLETE', warnings: [], errors: [] } },
              { build: { data: { type: 'builds', id: 'b9' } } },
            ),
          }),
      ],
    ]);
    const result = await uploadBuild(client(), { appId: '123', path, platform: 'IOS', shortVersion: '2.0', buildNumber: '41', wait: true, timeoutMs: 3_600_000 });
    expect(result).toMatchObject({ state: 'COMPLETE', buildId: 'b9' });
    expect(calls[0]?.body).toEqual({
      data: {
        type: 'buildUploads',
        attributes: { cfBundleShortVersionString: '2.0', cfBundleVersion: '41', platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: '123' } } },
      },
    });
    expect(calls[1]?.body).toMatchObject({ data: { attributes: { fileName: 'App.ipa', fileSize: 20, uti: 'com.apple.ipa', assetType: 'ASSET' } } });
    const parts = calls.filter((call) => call.method === 'PUT').map((call) => Buffer.from(call.raw as Uint8Array).toString());
    expect(parts.sort()).toEqual(['0123456789ab', 'cdefghij']);
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      data: {
        type: 'buildUploadFiles',
        id: 'f1',
        attributes: { uploaded: true, sourceFileChecksums: { file: { hash: createHash('md5').update(data).digest('hex'), algorithm: 'MD5' } } },
      },
    });
    expect(calls.filter((call) => call.path === '/v1/buildUploads/bu1')[0]?.url).toContain('include=build');
  });
});
