import { audit } from './commands/audit.js';
import { build } from './commands/build.js';
import type { Command, Context } from './commands/context.js';
import { doctor } from './commands/doctor.js';
import { init } from './commands/init.js';
import { pull, push } from './commands/listing.js';
import { release, status, submit } from './commands/release.js';
import { screenshots } from './commands/screenshots.js';
import { keywords, login, logout, mcp, popularity, projects, research, suggest } from './commands/searvia.js';
import { workflow } from './commands/workflow.js';
import { GLOBAL_OPTIONS, parseArgs, renderOptions } from './core/args.js';
import { loadConfig } from './core/config.js';
import { ApiError, CliError } from './core/errors.js';
import { Output } from './core/output.js';
import { VERSION } from './version.js';

export const COMMANDS: Command[] = [
  init,
  doctor,
  pull,
  push,
  audit,
  screenshots,
  build,
  release,
  status,
  submit,
  workflow,
  login,
  logout,
  projects,
  keywords,
  research,
  suggest,
  popularity,
  mcp,
];

const GROUPS: Array<[string, string[]]> = [
  ['Setup', ['init', 'doctor']],
  ['Store listings', ['pull', 'push', 'audit', 'screenshots']],
  ['Builds and releases', ['build', 'release', 'status', 'submit', 'workflow']],
  ['Searvia (free account)', ['login', 'logout', 'projects', 'keywords', 'research', 'popularity', 'suggest', 'mcp']],
];

export function mainHelp(): string {
  const byName = new Map(COMMANDS.map((command) => [command.name, command]));
  const lines = [
    `searvia ${VERSION} — App Store Connect and Google Play from the terminal, with an offline ASO audit.`,
    '',
    'Usage: searvia <command> [options]        npx searvia <command>',
  ];
  for (const [title, names] of GROUPS) {
    lines.push('', `${title}:`);
    for (const name of names) lines.push(`  ${name.padEnd(13)}${byName.get(name)?.summary ?? ''}`);
  }
  lines.push(
    '',
    'Global options:',
    renderOptions(GLOBAL_OPTIONS),
    '',
    'Writes are dry runs that print a diff until you add --yes.',
    'Docs: https://searvia.com/cli · Run `searvia <command> --help` for details.',
  );
  return lines.join('\n');
}

export function commandHelp(command: Command): string {
  const lines = [`searvia ${command.name} — ${command.summary}`, '', `Usage: ${command.usage}`];
  if (command.description) lines.push('', wrap(command.description, 100));
  if (command.options.length) lines.push('', 'Options:', renderOptions(command.options));
  lines.push('', 'Global options:', renderOptions(GLOBAL_OPTIONS));
  if (command.examples?.length) lines.push('', 'Examples:', ...command.examples.map((example) => `  ${example}`));
  return lines.join('\n');
}

function wrap(text: string, width: number): string {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.join('\n');
}

export interface MainOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** Runs one command line; returns the exit code (never calls process.exit, so it is safe in tests and workflows). */
export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const [name, ...rest] = argv;
  const quick = new Output({ stdout, stderr, color: false });

  if (!name || name === 'help' || name === '--help' || name === '-h') {
    const target = name === 'help' ? COMMANDS.find((command) => command.name === rest[0]) : undefined;
    quick.log(target ? commandHelp(target) : mainHelp());
    return 0;
  }
  if (name === '--version' || name === '-v' || name === 'version') {
    quick.log(VERSION);
    return 0;
  }

  const command = COMMANDS.find((item) => item.name === name);
  if (!command) {
    quick.error(`Unknown command "${name}".`);
    quick.log('Run `searvia --help` to see the commands.');
    return 2;
  }

  let out = new Output({ stdout, stderr, json: rest.includes('--json'), color: rest.includes('--no-color') ? false : undefined });
  try {
    const parsed = parseArgs(rest, command.options);
    out = new Output({
      stdout,
      stderr,
      json: Boolean(parsed.options.json),
      verbose: Boolean(parsed.options.verbose),
      color: parsed.options.color === false || parsed.options.noColor ? false : undefined,
    });
    if (parsed.options.help) {
      out.log(commandHelp(command));
      return 0;
    }
    const loaded = loadConfig({ cwd, env, file: parsed.options.config as string | undefined });
    const context: Context = {
      out,
      loaded,
      options: parsed.options,
      positionals: parsed.positionals,
      apply: Boolean(parsed.options.yes),
      env,
      cwd,
      // Nested runs (workflow steps) keep stdout clean for the parent's JSON document.
      run: (next) => main(next, { env, cwd, stdout: out.json ? stderr : stdout, stderr }),
    };
    const result = await command.run(context);
    out.result(result ?? { ok: true });
    return 0;
  } catch (error) {
    return report(out, error);
  }
}

function report(out: Output, error: unknown): number {
  if (error instanceof CliError) {
    const printed = (error.details as { printed?: boolean } | undefined)?.printed;
    if (out.json && !printed)
      out.result({
        error: {
          message: error.message,
          hint: error.hint,
          status: error instanceof ApiError ? error.status : undefined,
          details: error instanceof ApiError ? error.details : undefined,
        },
      });
    out.error(error.message);
    if (error.hint) out.log(out.paint('gray', `  ${error.hint}`));
    if (error.hint && out.json) out.warn(error.hint);
    if (out.verbose && error instanceof ApiError && error.details) out.debug(JSON.stringify(error.details));
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (out.json) out.result({ error: { message } });
  out.error(message);
  if (out.verbose && error instanceof Error && error.stack) out.debug(error.stack);
  return 1;
}
