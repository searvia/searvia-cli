import { open, stat } from 'node:fs/promises';
import type { ServiceAccount } from '../core/config.js';
import { ApiError, CliError } from '../core/errors.js';
import { httpRequest, readJson } from '../core/http.js';
import { signGoogleAssertion } from '../core/jwt.js';
import type { Output } from '../core/output.js';
import { isRecord, timing } from '../core/util.js';

export const PLAY_BASE = 'https://androidpublisher.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

export interface Listing {
  language: string;
  title?: string;
  shortDescription?: string;
  fullDescription?: string;
  video?: string;
}

export interface PlayImage {
  id: string;
  url?: string;
  sha1?: string;
  sha256?: string;
}

export interface TrackRelease {
  name?: string;
  versionCodes?: string[];
  status?: 'draft' | 'inProgress' | 'halted' | 'completed';
  userFraction?: number;
  releaseNotes?: Array<{ language: string; text: string }>;
  inAppUpdatePriority?: number;
}

export interface Track {
  track: string;
  releases?: TrackRelease[];
}

/** 8 MiB: resumable chunks must be multiples of 256 KiB except the last one. */
export const CHUNK_SIZE = 32 * 256 * 1024;

/**
 * Google Play Developer API v3 client. Every change happens inside an edit (edits.insert → changes → edits.commit);
 * access tokens come from the service-account JWT bearer flow and are cached for their lifetime.
 * https://developers.google.com/android-publisher/api-ref/rest/v3/edits
 */
export class GooglePlay {
  private token?: { value: string; expires: number };

  constructor(
    private readonly account: ServiceAccount,
    readonly packageName: string,
    private readonly out?: Output,
  ) {}

  private async bearer(): Promise<string> {
    const now = timing.now();
    if (this.token && this.token.expires - now > 60_000) return this.token.value;
    const audience = this.account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const assertion = signGoogleAssertion({
      clientEmail: this.account.client_email,
      privateKey: this.account.private_key,
      privateKeyId: this.account.private_key_id,
      scope: SCOPE,
      audience,
      now,
    });
    const response = await httpRequest(
      {
        method: 'POST',
        url: audience,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      },
      { service: 'Google OAuth', out: this.out },
    );
    const body = (await readJson(response)) as Record<string, unknown> | null;
    if (!response.ok || typeof body?.access_token !== 'string') {
      throw new ApiError(
        'Google OAuth',
        response.status,
        String(body?.error_description ?? body?.error ?? `HTTP ${response.status}`),
        body,
        'Check the service account JSON key; it may have been deleted or disabled.',
      );
    }
    this.token = { value: body.access_token, expires: now + Number(body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private appPath(path: string): string {
    return `/androidpublisher/v3/applications/${encodeURIComponent(this.packageName)}${path}`;
  }

  async request<T = Record<string, unknown>>(
    method: string,
    path: string,
    options: { query?: Record<string, string | boolean | number | undefined>; body?: unknown; base?: string } = {},
  ): Promise<T> {
    const url = new URL(`${options.base ?? PLAY_BASE}${this.appPath(path)}`);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await httpRequest(
      {
        method,
        url: url.toString(),
        headers: { Authorization: `Bearer ${await this.bearer()}`, Accept: 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      },
      { service: 'Google Play', out: this.out },
    );
    const body = await readJson(response);
    if (!response.ok) throw this.error(response.status, body);
    return (body ?? {}) as T;
  }

  error(status: number, body: unknown): ApiError {
    const message = isRecord(body) && isRecord(body.error) ? String(body.error.message ?? `HTTP ${status}`) : `HTTP ${status}`;
    let hint: string | undefined;
    if (status === 401) hint = 'The service account token was rejected; download a new JSON key.';
    if (status === 403) hint = `Invite ${this.account.client_email} in Play Console › Users and permissions with release and store listing permissions for ${this.packageName}.`;
    if (status === 404) hint = `Package ${this.packageName} not found for this account. The app must exist in Play Console (and the first build is uploaded there once).`;
    return new ApiError('Google Play', status, message, body, hint);
  }

  // Edits ---------------------------------------------------------------------------------------------------------

  async insertEdit(): Promise<string> {
    const edit = await this.request<{ id: string }>('POST', '/edits', { body: {} });
    return edit.id;
  }

  async deleteEdit(editId: string): Promise<void> {
    await this.request('DELETE', `/edits/${editId}`).catch(() => undefined);
  }

  async commitEdit(editId: string, options: { changesNotSentForReview?: boolean } = {}): Promise<void> {
    await this.request('POST', `/edits/${editId}:commit`, { query: { changesNotSentForReview: options.changesNotSentForReview || undefined } });
  }

  async validateEdit(editId: string): Promise<void> {
    await this.request('POST', `/edits/${editId}:validate`);
  }

  /** Runs `work` in a fresh edit; commits when `commit` is set, otherwise discards the edit (read-only/dry run). */
  async withEdit<T>(work: (editId: string) => Promise<T>, options: { commit: boolean; changesNotSentForReview?: boolean }): Promise<T> {
    const editId = await this.insertEdit();
    try {
      const result = await work(editId);
      if (options.commit) await this.commitEdit(editId, { changesNotSentForReview: options.changesNotSentForReview });
      else await this.deleteEdit(editId);
      return result;
    } catch (error) {
      await this.deleteEdit(editId);
      throw error;
    }
  }

  async listings(editId: string): Promise<Listing[]> {
    return (await this.request<{ listings?: Listing[] }>('GET', `/edits/${editId}/listings`)).listings ?? [];
  }

  async patchListing(editId: string, language: string, listing: Partial<Listing>): Promise<Listing> {
    return this.request<Listing>('PATCH', `/edits/${editId}/listings/${encodeURIComponent(language)}`, { body: listing });
  }

  async updateListing(editId: string, language: string, listing: Partial<Listing>): Promise<Listing> {
    return this.request<Listing>('PUT', `/edits/${editId}/listings/${encodeURIComponent(language)}`, { body: { ...listing, language } });
  }

  async images(editId: string, language: string, type: string): Promise<PlayImage[]> {
    return (await this.request<{ images?: PlayImage[] }>('GET', `/edits/${editId}/listings/${encodeURIComponent(language)}/${type}`)).images ?? [];
  }

  async deleteAllImages(editId: string, language: string, type: string): Promise<void> {
    await this.request('DELETE', `/edits/${editId}/listings/${encodeURIComponent(language)}/${type}`);
  }

  /** edits.images.upload, simple media upload (≤ 15 MB). */
  async uploadImage(editId: string, language: string, type: string, data: Buffer, contentType: string): Promise<PlayImage> {
    const url = `${PLAY_BASE}/upload${this.appPath(`/edits/${editId}/listings/${encodeURIComponent(language)}/${type}`)}?uploadType=media`;
    const response = await httpRequest(
      { method: 'POST', url, headers: { Authorization: `Bearer ${await this.bearer()}`, 'Content-Type': contentType }, body: data },
      { service: 'Google Play', out: this.out },
    );
    const body = await readJson(response);
    if (!response.ok) throw this.error(response.status, body);
    return ((body as { image?: PlayImage }).image ?? body) as PlayImage;
  }

  async track(editId: string, track: string): Promise<Track> {
    return this.request<Track>('GET', `/edits/${editId}/tracks/${encodeURIComponent(track)}`);
  }

  async tracks(editId: string): Promise<Track[]> {
    return (await this.request<{ tracks?: Track[] }>('GET', `/edits/${editId}/tracks`)).tracks ?? [];
  }

  async updateTrack(editId: string, track: Track): Promise<Track> {
    return this.request<Track>('PUT', `/edits/${editId}/tracks/${encodeURIComponent(track.track)}`, { body: track });
  }

  /**
   * edits.bundles.upload with the resumable protocol: start a session (X-Upload-Content-Type/-Length), then PUT
   * 8 MiB chunks with Content-Range; 308 + Range tells where to continue. Returns the bundle's versionCode.
   * https://developers.google.com/android-publisher/upload
   */
  async uploadBundle(
    editId: string,
    path: string,
    options: { onProgress?: (sent: number, total: number) => void; ackBundleInstallationWarning?: boolean } = {},
  ): Promise<{ versionCode: number; sha256?: string }> {
    const { size } = await stat(path);
    const start = new URL(`${PLAY_BASE}/resumable/upload${this.appPath(`/edits/${editId}/bundles`)}`);
    start.searchParams.set('uploadType', 'resumable');
    if (options.ackBundleInstallationWarning) start.searchParams.set('ackBundleInstallationWarning', 'true');
    const session = await httpRequest(
      {
        method: 'POST',
        url: start.toString(),
        headers: {
          Authorization: `Bearer ${await this.bearer()}`,
          'X-Upload-Content-Type': 'application/octet-stream',
          'X-Upload-Content-Length': String(size),
          'Content-Length': '0',
        },
      },
      { service: 'Google Play', out: this.out },
    );
    if (!session.ok) throw this.error(session.status, await readJson(session));
    const location = session.headers.get('location');
    if (!location) throw new CliError('Google Play did not return an upload session.');

    const handle = await open(path, 'r');
    try {
      let offset = 0;
      for (let attempts = 0; attempts < 10_000; attempts++) {
        const length = Math.min(CHUNK_SIZE, size - offset);
        const chunk = Buffer.alloc(length);
        await handle.read(chunk, 0, length, offset);
        const response = await httpRequest(
          {
            method: 'PUT',
            url: location,
            headers: {
              Authorization: `Bearer ${await this.bearer()}`,
              'Content-Length': String(length),
              'Content-Range': length ? `bytes ${offset}-${offset + length - 1}/${size}` : `bytes */${size}`,
            },
            body: chunk,
            accept: [308],
          },
          { service: 'Google Play', out: this.out },
        );
        if (response.status === 308) {
          const range = response.headers.get('range');
          offset = range ? Number(range.split('-')[1]) + 1 : 0;
          await response.arrayBuffer().catch(() => undefined);
          options.onProgress?.(offset, size);
          continue;
        }
        const body = await readJson(response);
        if (!response.ok) throw this.error(response.status, body);
        options.onProgress?.(size, size);
        const bundle = body as { versionCode?: number; sha256?: string };
        if (typeof bundle.versionCode !== 'number') throw new CliError('Google Play accepted the upload but returned no versionCode.');
        return { versionCode: bundle.versionCode, sha256: bundle.sha256 };
      }
      throw new CliError('The bundle upload did not finish.');
    } finally {
      await handle.close();
    }
  }
}
