import type { AscCredentials } from '../core/config.js';
import { ApiError } from '../core/errors.js';
import { httpRequest, readJson } from '../core/http.js';
import { signAppStoreConnectToken } from '../core/jwt.js';
import type { Output } from '../core/output.js';
import { isRecord, timing } from '../core/util.js';

export const ASC_BASE = 'https://api.appstoreconnect.apple.com';

// biome-ignore lint/suspicious/noExplicitAny: JSON:API attributes are dynamic.
export type Attributes = Record<string, any>;

export interface Resource {
  type: string;
  id: string;
  attributes?: Attributes;
  relationships?: Record<string, { data?: { type: string; id: string } | Array<{ type: string; id: string }> | null; links?: Record<string, string> }>;
}

export interface Document {
  data: Resource | Resource[] | null;
  included?: Resource[];
  links?: { self?: string; next?: string };
  meta?: Record<string, unknown>;
}

export type Query = Record<string, string | number | boolean | undefined>;

/**
 * App Store Connect API client (JSON:API over HTTPS, ES256 bearer tokens refreshed before their 20-minute limit).
 * https://developer.apple.com/documentation/appstoreconnectapi
 */
export class AppStoreConnect {
  private token?: { value: string; expires: number };

  constructor(
    private readonly credentials: AscCredentials,
    private readonly out?: Output,
    readonly baseUrl = ASC_BASE,
  ) {}

  private bearer(): string {
    const now = timing.now();
    if (!this.token || this.token.expires - now < 60_000) {
      this.token = { value: signAppStoreConnectToken({ ...this.credentials, now }), expires: now + 1_140_000 };
    }
    return this.token.value;
  }

  url(path: string, query?: Query): string {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async request(method: string, path: string, options: { query?: Query; body?: unknown; accept?: number[] } = {}): Promise<Document> {
    const response = await httpRequest(
      {
        method,
        url: this.url(path, options.query),
        headers: { Authorization: `Bearer ${this.bearer()}`, Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
        accept: options.accept,
      },
      { service: 'App Store Connect', out: this.out },
    );
    const body = await readJson(response);
    if (options.accept?.includes(response.status)) return { data: null, meta: { status: response.status } };
    if (!response.ok) throw ascError(response.status, body);
    return (isRecord(body) ? body : { data: null }) as unknown as Document;
  }

  get(path: string, query?: Query): Promise<Document> {
    return this.request('GET', path, { query });
  }

  /** GET that returns null on 404 (e.g. a version without review details). */
  async find(path: string, query?: Query): Promise<Resource | null> {
    const document = await this.request('GET', path, { query, accept: [404] });
    return (document.data as Resource | null) ?? null;
  }

  /** Follows `links.next` and concatenates every page. */
  async getAll(path: string, query: Query = {}): Promise<{ data: Resource[]; included: Resource[] }> {
    const data: Resource[] = [];
    const included: Resource[] = [];
    let page: Document = await this.get(path, { limit: 200, ...query });
    for (let guard = 0; guard < 100; guard++) {
      data.push(...((page.data as Resource[]) ?? []));
      included.push(...(page.included ?? []));
      if (!page.links?.next) break;
      page = await this.get(page.links.next);
    }
    return { data, included };
  }

  async post(path: string, body: unknown): Promise<Resource> {
    return (await this.request('POST', path, { body })).data as Resource;
  }

  async patch(path: string, body: unknown): Promise<Resource | null> {
    return (await this.request('PATCH', path, { body })).data as Resource | null;
  }

  async delete(path: string): Promise<void> {
    await this.request('DELETE', path);
  }
}

export function ascError(status: number, body: unknown): ApiError {
  const errors = isRecord(body) && Array.isArray(body.errors) ? (body.errors as Array<Record<string, unknown>>) : [];
  const first = errors[0];
  const message = first ? String(first.detail ?? first.title ?? `HTTP ${status}`) : `HTTP ${status}`;
  const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
  let hint: string | undefined;
  if (status === 401) hint = 'Check ASC_KEY_ID, ASC_ISSUER_ID and the .p8 key (team keys need the issuer id; individual keys must leave it empty).';
  if (status === 403) hint = 'The API key lacks a role for this. Use a key with the App Manager role (Admin for agreements and users).';
  return new ApiError('App Store Connect', status, `${message}${more}`, errors, hint);
}

/** `relationships.<name>.data.id` of a resource. */
export function relatedId(resource: Resource | null | undefined, name: string): string | undefined {
  const data = resource?.relationships?.[name]?.data;
  return data && !Array.isArray(data) ? data.id : undefined;
}

export function ref(type: string, id: string): { data: { type: string; id: string } } {
  return { data: { type, id } };
}
