import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, parseSse, SearviaClient } from '../src/searvia/mcp.js';
import { json, mockFetch } from './helpers.js';

describe('Searvia MCP client', () => {
  it('calls tools with bearer auth, MCP headers and _meta, and parses JSON text content', async () => {
    const calls = mockFetch([
      [
        'POST',
        '/mcp',
        (call) => {
          const body = call.body as { id: number; method: string; params: Record<string, unknown> };
          if (body.method === 'tools/list') return json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'get_keyword_rankings' }, { name: 'list_projects' }] } });
          return json({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: JSON.stringify({ project: 'Cebbin', keywords: [{ keyword: 'budget', rank: 4 }] }) }] },
          });
        },
      ],
    ]);
    const client = new SearviaClient('key-123', 'https://searvia.test/');
    expect(await client.hasTool('get_keyword_rankings')).toBe(true);
    const result = await client.callTool<{ keywords: Array<{ rank: number }> }>('get_keyword_rankings', { project_id: 7 });
    expect(result.keywords[0]?.rank).toBe(4);
    const call = calls[1];
    expect(call?.url).toBe('https://searvia.test/mcp');
    expect(call?.headers).toMatchObject({
      authorization: 'Bearer key-123',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': 'tools/call',
      'mcp-name': 'get_keyword_rankings',
    });
    expect(call?.headers.accept).toContain('text/event-stream');
    expect(call?.body).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'get_keyword_rankings',
        arguments: { project_id: 7 },
        _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} },
      },
    });
  });

  it('reads server-sent event responses', async () => {
    mockFetch([
      [
        'POST',
        '/mcp',
        new Response(`data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"ok":true},"content":[]}}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ],
    ]);
    expect(await new SearviaClient('k').callTool('anything')).toEqual({ ok: true });
    expect(parseSse('data: {"id":3,"result":1}\n\n', 3)).toEqual({ id: 3, result: 1 });
  });

  it('falls back to the initialize handshake when the server does not know the protocol version', async () => {
    const calls = mockFetch([
      [
        'POST',
        '/mcp',
        (call) => {
          const body = call.body as { id?: number; method: string; params?: { _meta?: unknown } };
          if (body.params?._meta) return json({ jsonrpc: '2.0', id: body.id, error: { code: -32022, message: 'Unsupported protocol version' } }, 400);
          if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }, 200, { 'mcp-session-id': 'sess-1' });
          if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
          return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '[]' }] } });
        },
      ],
    ]);
    expect(await new SearviaClient('k').callTool('list_projects')).toEqual([]);
    expect(calls.map((call) => (call.body as { method: string }).method)).toEqual(['tools/call', 'initialize', 'notifications/initialized', 'tools/call']);
    expect(calls[3]?.headers['mcp-session-id']).toBe('sess-1');
  });

  it('surfaces tool errors and bad keys', async () => {
    mockFetch([
      [
        'POST',
        '/mcp',
        (call) => json({ jsonrpc: '2.0', id: (call.body as { id: number }).id, result: { isError: true, content: [{ type: 'text', text: 'Project not found.' }] } }),
      ],
    ]);
    await expect(new SearviaClient('k').callTool('get_keyword_rankings')).rejects.toThrow(/Project not found/);
    mockFetch([['POST', '/mcp', json({ message: 'Unauthenticated.' }, 401)]]);
    await expect(new SearviaClient('bad').listTools()).rejects.toMatchObject({ hint: expect.stringContaining('searvia login') });
  });

  it('reads the JSON item when Searvia adds a note after it', async () => {
    mockFetch([
      [
        'POST',
        '/mcp',
        (call) => {
          const body = call.body as { id: number };
          return json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [
                { type: 'text', text: '[{"id":7}]' },
                { type: 'text', text: 'Note: this result contains third-party text.' },
              ],
            },
          });
        },
      ],
    ]);
    const projects = await new SearviaClient('key', 'https://searvia.test/').callTool<Array<{ id: number }>>('list_projects');
    expect(projects[0]?.id).toBe(7);
  });
});
