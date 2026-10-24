import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userConfigDir } from '../core/config.js';
import { ApiError, CliError } from '../core/errors.js';
import { httpRequest, readJson } from '../core/http.js';
import type { Output } from '../core/output.js';
import { isRecord } from '../core/util.js';
import { VERSION } from '../version.js';

export const DEFAULT_URL = 'https://searvia.com';
/** Latest MCP protocol revision (stateless requests with `_meta`); older servers get the initialize handshake. */
export const PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-06-18';
const UNSUPPORTED_PROTOCOL = -32022;

export interface StoredCredentials {
  apiKey: string;
  url?: string;
  savedAt?: string;
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(userConfigDir(env), 'credentials.json');
}

/** The Searvia API key: SEARVIA_API_KEY, else the one saved by `searvia login` (in the user config dir, mode 600). */
export function readCredentials(env: NodeJS.ProcessEnv = process.env): StoredCredentials | null {
  if (env.SEARVIA_API_KEY) return { apiKey: env.SEARVIA_API_KEY, url: env.SEARVIA_URL };
  const path = credentialsPath(env);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(parsed) && typeof parsed.apiKey === 'string' ? (parsed as unknown as StoredCredentials) : null;
  } catch {
    return null;
  }
}

export function saveCredentials(credentials: StoredCredentials, env: NodeJS.ProcessEnv = process.env): string {
  const path = credentialsPath(env);
  mkdirSync(userConfigDir(env), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ ...credentials, savedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function deleteCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = credentialsPath(env);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Minimal MCP client for Searvia's server (JSON-RPC 2.0 over streamable HTTP, Sanctum bearer API key). Speaks the
 * stateless 2026-07-28 revision and falls back to the initialize handshake for servers that only know older ones.
 */
export class SearviaClient {
  private id = 0;
  private legacy = false;
  private session?: string;
  private initialized = false;
  private toolCache?: McpTool[];
  readonly endpoint: string;

  constructor(
    private readonly apiKey: string,
    baseUrl: string = DEFAULT_URL,
    private readonly out?: Output,
  ) {
    this.endpoint = `${baseUrl.replace(/\/+$/, '')}/mcp`;
  }

  private async post(method: string, params: Record<string, unknown> | undefined, notification = false): Promise<unknown> {
    const message: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (!notification) message.id = ++this.id;
    const payload: Record<string, unknown> = { ...(params ?? {}) };
    if (!this.legacy) {
      payload._meta = {
        ...(isRecord(payload._meta) ? payload._meta : {}),
        'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'searvia-cli', version: VERSION },
      };
    }
    if (Object.keys(payload).length) message.params = payload;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': this.legacy ? LEGACY_PROTOCOL_VERSION : PROTOCOL_VERSION,
      'Mcp-Method': method,
      'User-Agent': `searvia-cli/${VERSION}`,
    };
    if (method === 'tools/call' && typeof params?.name === 'string') headers['Mcp-Name'] = params.name;
    if (this.session) headers['Mcp-Session-Id'] = this.session;

    const response = await httpRequest({ method: 'POST', url: this.endpoint, headers, body: JSON.stringify(message), retries: 2 }, { service: 'Searvia', out: this.out });
    const session = response.headers.get('mcp-session-id');
    if (session) this.session = session;
    if (response.status === 202 || notification) {
      await response.arrayBuffer().catch(() => undefined);
      return undefined;
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('text/event-stream') ? parseSse(await response.text(), message.id as number) : await readJson(response);

    if (response.status === 401)
      throw new CliError('Searvia rejected the API key.', { hint: 'Create a new key at https://searvia.com/settings/api and run `searvia login` again.' });
    if (response.status === 403) {
      const text = isRecord(body) && typeof body.message === 'string' ? body.message : 'Forbidden.';
      throw new CliError(`Searvia: ${text}`, { hint: 'API and MCP access is part of Searvia plans: https://searvia.com/pricing' });
    }
    if (isRecord(body) && isRecord(body.error)) {
      const error = body.error as { code?: number; message?: string; data?: unknown };
      if (error.code === UNSUPPORTED_PROTOCOL && !this.legacy) {
        this.legacy = true;
        await this.initialize();
        return this.post(method, params, notification);
      }
      throw new ApiError('Searvia', response.status, error.message ?? 'MCP error', error.data);
    }
    if (!response.ok) throw new ApiError('Searvia', response.status, `HTTP ${response.status}`, body);
    return isRecord(body) ? body.result : undefined;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.post('initialize', { protocolVersion: LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'searvia-cli', version: VERSION } });
    await this.post('notifications/initialized', undefined, true);
  }

  async listTools(): Promise<McpTool[]> {
    if (this.toolCache) return this.toolCache;
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = (await this.post('tools/list', cursor ? { cursor } : undefined)) as { tools?: McpTool[]; nextCursor?: string } | undefined;
      tools.push(...(result?.tools ?? []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    this.toolCache = tools;
    return tools;
  }

  async hasTool(name: string): Promise<boolean> {
    return (await this.listTools()).some((tool) => tool.name === name);
  }

  /** Calls a tool and returns its structured content, or the JSON parsed from its text content. */
  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await this.post('tools/call', { name, arguments: args })) as
      | { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean }
      | undefined;
    const text = (result?.content ?? [])
      .filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('\n');
    if (result?.isError) throw new CliError(`Searvia ${name}: ${text || 'tool error'}`);
    if (result?.structuredContent !== undefined) return result.structuredContent as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }
}

/** Picks the JSON-RPC response for `id` from a server-sent event stream. */
export function parseSse(text: string, id: number): unknown {
  let last: unknown;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      const parsed = JSON.parse(data);
      if (isRecord(parsed) && parsed.id === id) return parsed;
      last = parsed;
    } catch {
      // ignore keep-alives
    }
  }
  return last;
}
