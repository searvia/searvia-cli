import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectAgents, connectCursor, type Runner } from '../src/commands/connect.js';
import { tempDir } from './helpers.js';

const URL = 'https://searvia.com/mcp';

function fakeRunner(installed: string[], listed = ''): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = (program, args) => {
    calls.push([program, ...args]);
    if (!installed.includes(program)) return { ok: false, output: '' };
    return { ok: true, output: args.includes('list') ? listed : '' };
  };
  return { runner, calls };
}

describe('searvia connect', () => {
  it('adds the server to the agents it finds and skips the others', () => {
    const { runner, calls } = fakeRunner(['claude', 'code']);
    const results = connectAgents(URL, { runner, home: tempDir() });

    expect(results.find((item) => item.agent === 'Claude Code')?.status).toBe('added');
    expect(results.find((item) => item.agent === 'VS Code')?.status).toBe('added');
    expect(results.find((item) => item.agent === 'Codex')?.status).toBe('missing');
    expect(calls).toContainEqual(['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'user', 'searvia', URL]);
    expect(calls).toContainEqual(['code', '--add-mcp', JSON.stringify({ name: 'searvia', type: 'http', url: URL })]);
  });

  it('does not add twice', () => {
    const { runner, calls } = fakeRunner(['claude'], 'searvia: https://searvia.com/mcp (HTTP)');
    const results = connectAgents(URL, { runner, home: tempDir() });

    expect(results.find((item) => item.agent === 'Claude Code')?.status).toBe('present');
    expect(calls.some((call) => call.includes('add'))).toBe(false);
  });

  it('changes nothing in a dry run', () => {
    const home = tempDir();
    mkdirSync(join(home, '.cursor'));
    const { runner, calls } = fakeRunner(['claude']);
    const results = connectAgents(URL, { runner, home, dryRun: true });

    expect(results.find((item) => item.agent === 'Claude Code')?.status).toBe('would-add');
    expect(results.find((item) => item.agent === 'Cursor')?.status).toBe('would-add');
    expect(calls.some((call) => call.includes('add'))).toBe(false);
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('reports the first line of a failure', () => {
    const runner: Runner = (_program, args) => (args.includes('add') ? { ok: false, output: 'boom\nstack' } : { ok: true, output: '' });
    expect(connectAgents(URL, { runner, home: tempDir() })[0]).toMatchObject({ status: 'failed', note: 'boom' });
  });

  it("keeps Cursor's other servers", () => {
    const home = tempDir();
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { url: 'https://other.test' } }, extra: 1 }));

    expect(connectCursor(home, URL, false).status).toBe('added');
    expect(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { other: { url: 'https://other.test' }, searvia: { url: URL } }, extra: 1 });
    expect(connectCursor(home, URL, false).status).toBe('present');
  });

  it('leaves a broken Cursor file alone and skips Cursor when it is not installed', () => {
    const home = tempDir();
    expect(connectCursor(home, URL, false).status).toBe('missing');
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{broken');

    expect(connectCursor(home, URL, false).status).toBe('failed');
    expect(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe('{broken');
  });
});
