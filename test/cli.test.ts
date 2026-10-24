import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { VERSION } from '../src/version.js';
import { json, mockFetch, tempDir, writeFiles } from './helpers.js';

function sink() {
  let text = '';
  const write = (chunk: string) => {
    text += chunk;
    return true;
  };
  return { stream: { write } as unknown as NodeJS.WritableStream, text: () => text };
}

async function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const out = sink();
  const err = sink();
  const code = await main(argv, { cwd, env: { SEARVIA_HOME: join(cwd, '.home'), ...env }, stdout: out.stream, stderr: err.stream });
  return { code, stdout: out.text(), stderr: err.text() };
}

function project() {
  const dir = tempDir();
  writeFiles(dir, {
    'searvia.config.json': JSON.stringify({ ios: { bundleId: 'com.example.app', brand: ['Cebbin'] } }),
    'fastlane/metadata/en-US/name.txt': 'Cebbin Budget\n',
    'fastlane/metadata/en-US/subtitle.txt': 'Expense tracker',
    'fastlane/metadata/en-US/keywords.txt': 'money, budget,app',
  });
  return dir;
}

describe('cli', () => {
  it('prints help, version and rejects unknown commands', async () => {
    const dir = tempDir();
    expect((await run(['--help'], dir)).stdout).toContain('searvia <command>');
    expect((await run(['--version'], dir)).stdout.trim()).toBe(VERSION);
    expect(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version).toBe(VERSION);
    expect((await run(['nope'], dir)).code).toBe(2);
    expect((await run(['audit', '--bogus'], dir)).code).toBe(2);
    expect((await run(['push', '--help'], dir)).stdout).toContain('--create-locales');
  });

  it('audit --json writes one JSON document and works without keys', async () => {
    const dir = project();
    const result = await run(['audit', '--json'], dir);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.reports[0].platform).toBe('ios');
    expect(parsed.reports[0].locales[0].issues.some((issue: { rule: string }) => issue.rule === 'repetition')).toBe(true);
  });

  it('audit --min-score fails CI with exit code 3', async () => {
    const result = await run(['audit', '--min-score', '99', '--json'], project());
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout).failing[0]).toContain('en-US');
  });

  it('audit --fix --yes rewrites keywords.txt', async () => {
    const dir = project();
    await run(['audit', '--fix', '--yes'], dir);
    expect(readFileSync(join(dir, 'fastlane/metadata/en-US/keywords.txt'), 'utf8').trim()).toBe('money');
  });

  it('Searvia commands explain how to get a free account when not logged in', async () => {
    const result = await run(['keywords'], tempDir());
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain('https://searvia.com');
  });

  it('keywords reads ranks over MCP with SEARVIA_API_KEY and matches the project by bundle id', async () => {
    mockFetch([
      [
        'POST',
        '/mcp',
        (call) => {
          const body = call.body as { id: number; params: { name: string; arguments: Record<string, unknown> } };
          const reply = (value: unknown) => json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
          if (body.params.name === 'list_projects')
            return reply([
              { id: 3, type: 'app', name: 'Other', store: 'apple', store_app_id: '1' },
              { id: 7, type: 'app', name: 'Cebbin', store: 'apple', store_app_id: 'com.example.app' },
            ]);
          expect(body.params.arguments).toEqual({ project_id: 7, days: 30 });
          return reply({ project: 'Cebbin', keywords: [{ keyword: 'budget', country: 'US', rank: 5, change_7d: 2, popularity: { score: 41 } }] });
        },
      ],
    ]);
    const result = await run(['keywords', '--json'], project(), { SEARVIA_API_KEY: 'k', SEARVIA_URL: 'https://searvia.test' });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).keywords[0].keyword).toBe('budget');
  });

  it('workflow runs steps in order and stops on failure', async () => {
    const dir = project();
    writeFiles(dir, { 'flow.yml': 'name: CI\nsteps:\n  - run: audit\n  - run: audit --min-score 99\n  - run: audit\n' });
    const result = await run(['workflow', 'run', 'flow.yml'], dir);
    expect(result.code).toBe(3);
    expect(result.stdout).toContain('[2/3]');
    expect(result.stdout).not.toContain('[3/3]');
  });

  it('init writes both configs and git-ignores .searvia/', async () => {
    const dir = tempDir();
    writeFiles(dir, { '.gitignore': 'node_modules\n', 'fastlane/Appfile': 'app_identifier("com.example.app")\npackage_name("com.example.android")\n' });
    const result = await run(['init', '--key-id', 'ABC', '--issuer-id', 'ISS', '--key-path', 'keys/AuthKey_ABC.p8'], dir);
    expect(result.code).toBe(0);
    const config = JSON.parse(readFileSync(join(dir, 'searvia.config.json'), 'utf8'));
    expect(config.ios.bundleId).toBe('com.example.app');
    expect(config.android.packageName).toBe('com.example.android');
    expect(JSON.parse(readFileSync(join(dir, '.searvia/config.json'), 'utf8')).ios).toEqual({ keyId: 'ABC', issuerId: 'ISS', privateKeyPath: 'keys/AuthKey_ABC.p8' });
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.searvia/\nkeys/AuthKey_ABC.p8');
  });
});
