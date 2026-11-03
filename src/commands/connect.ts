import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_URL } from '../searvia/mcp.js';
import type { Command } from './context.js';

export type AgentStatus = 'added' | 'present' | 'missing' | 'failed' | 'would-add';

export interface AgentResult {
  agent: string;
  status: AgentStatus;
  /** What the user does next to sign in (or why it failed). */
  note?: string;
}

/** Runs a program without a shell; `ok` is false when it is missing or exits non-zero. */
export type Runner = (program: string, args: string[]) => { ok: boolean; output: string };

const run: Runner = (program, args) => {
  const result = spawnSync(program, args, { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

interface CliAgent {
  agent: string;
  program: string;
  listed: string[];
  add: (url: string) => string[];
  note: string;
}

const CLI_AGENTS: CliAgent[] = [
  {
    agent: 'Claude Code',
    program: 'claude',
    listed: ['mcp', 'list'],
    add: (url) => ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'searvia', url],
    note: 'Run /mcp in Claude Code and choose searvia to sign in.',
  },
  {
    agent: 'Codex',
    program: 'codex',
    listed: ['mcp', 'list'],
    add: (url) => ['mcp', 'add', 'searvia', '--url', url],
    note: 'Run `codex mcp login searvia` to sign in.',
  },
  {
    agent: 'Gemini CLI',
    program: 'gemini',
    listed: ['mcp', 'list'],
    add: (url) => ['mcp', 'add', '--transport', 'http', 'searvia', url],
    note: 'Run /mcp auth searvia in Gemini CLI to sign in.',
  },
  {
    agent: 'VS Code',
    program: 'code',
    listed: ['--list-extensions'],
    add: (url) => ['--add-mcp', JSON.stringify({ name: 'searvia', type: 'http', url })],
    note: 'Open VS Code, start the searvia server and sign in.',
  },
];

function connectCli(agent: CliAgent, url: string, runner: Runner, dryRun: boolean): AgentResult {
  if (!runner(agent.program, ['--version']).ok) return { agent: agent.agent, status: 'missing' };
  // VS Code has no list command: --add-mcp replaces the entry of the same name, so adding again is safe.
  if (agent.program !== 'code' && /\bsearvia\b/i.test(runner(agent.program, agent.listed).output)) {
    return { agent: agent.agent, status: 'present', note: agent.note };
  }
  if (dryRun) return { agent: agent.agent, status: 'would-add', note: `${agent.program} ${agent.add(url).join(' ')}` };
  const added = runner(agent.program, agent.add(url));
  return added.ok ? { agent: agent.agent, status: 'added', note: agent.note } : { agent: agent.agent, status: 'failed', note: added.output.trim().split('\n')[0] };
}

/** Cursor has no command for this: Searvia goes into ~/.cursor/mcp.json next to the servers already there. */
export function connectCursor(home: string, url: string, dryRun: boolean): AgentResult {
  const agent = 'Cursor';
  const note = 'Open Cursor Settings › MCP and press Connect next to searvia to sign in.';
  if (!existsSync(join(home, '.cursor'))) return { agent, status: 'missing' };
  const path = join(home, '.cursor', 'mcp.json');
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { agent, status: 'failed', note: `${path} is not valid JSON; fix it and run this again.` };
    }
  }
  if (config.mcpServers?.searvia) return { agent, status: 'present', note };
  if (dryRun) return { agent, status: 'would-add', note: `add searvia to ${path}` };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...config, mcpServers: { ...config.mcpServers, searvia: { url } } }, null, 2)}\n`);
  return { agent, status: 'added', note };
}

export function connectAgents(url: string, options: { runner?: Runner; home?: string; dryRun?: boolean } = {}): AgentResult[] {
  const { runner = run, home = homedir(), dryRun = false } = options;
  return [...CLI_AGENTS.map((agent) => connectCli(agent, url, runner, dryRun)), connectCursor(home, url, dryRun)];
}

const LABEL: Record<AgentStatus, string> = { added: 'added', present: 'already there', missing: 'not found', failed: 'failed', 'would-add': 'would add' };

export const connect: Command = {
  name: 'connect',
  summary: 'Add the Searvia MCP server to the AI agents on this computer (no API key needed)',
  usage: 'searvia connect [--dry-run]',
  description:
    'Finds Claude Code, Codex, Gemini CLI, VS Code and Cursor and adds https://searvia.com/mcp to each. Other servers in their settings are left alone. Each agent signs in through your browser (OAuth); no key is stored.',
  options: [{ name: 'dry-run', type: 'boolean', description: 'Show what would change without changing anything.' }],
  examples: ['searvia connect', 'searvia connect --dry-run'],
  async run(context) {
    const url = `${(context.env.SEARVIA_URL || context.loaded.config.searvia?.url || DEFAULT_URL).replace(/\/+$/, '')}/mcp`;
    const results = connectAgents(url, { dryRun: Boolean(context.options.dryRun) });

    for (const result of results) {
      const line = `${result.agent.padEnd(12)} ${LABEL[result.status]}`;
      context.out.log(
        result.status === 'missing'
          ? context.out.paint('dim', line)
          : `${context.out.paint(result.status === 'failed' ? 'red' : 'green', line)}${result.note ? `  ${result.note}` : ''}`,
      );
    }
    if (results.every((result) => result.status === 'missing')) {
      context.out.log('\nNo agent found. For ChatGPT or Claude.ai, add a custom connector with this address and choose OAuth:');
      context.out.log(`  ${url}`);
    } else {
      context.out.log(context.out.paint('dim', '\nThen ask your agent: "Which of my keywords dropped this week?"'));
    }
    return { url, agents: results };
  },
};
