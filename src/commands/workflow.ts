import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splitCommandLine } from '../core/args.js';
import { CliError, UsageError } from '../core/errors.js';
import { isRecord } from '../core/util.js';
import { parseYaml } from '../core/yaml.js';
import type { Command } from './context.js';

export interface WorkflowStep {
  name?: string;
  run: string;
  /** Extra flags as a map: { platform: ios, locale: [en-US, tr] } → --platform ios --locale en-US,tr */
  with?: Record<string, unknown>;
  yes?: boolean;
  continueOnError?: boolean;
  if?: string;
}

export interface Workflow {
  name?: string;
  env?: Record<string, string>;
  steps: WorkflowStep[];
}

/** ${VAR} and ${VAR:-default} from the environment. */
export function interpolate(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => env[name] ?? fallback ?? '');
}

export function parseWorkflow(source: string): Workflow {
  const data = parseYaml(source);
  const steps = isRecord(data) ? data.steps : Array.isArray(data) ? data : undefined;
  if (!Array.isArray(steps) || steps.length === 0) throw new CliError('A workflow needs a non-empty `steps:` list.');
  return {
    name: isRecord(data) && typeof data.name === 'string' ? data.name : undefined,
    env: isRecord(data) && isRecord(data.env) ? Object.fromEntries(Object.entries(data.env).map(([key, value]) => [key, String(value)])) : undefined,
    steps: steps.map((step, index) => {
      if (typeof step === 'string') return { run: step };
      if (!isRecord(step) || typeof step.run !== 'string') throw new CliError(`Step ${index + 1} needs a \`run:\` command (e.g. "push --platform ios").`);
      return step as unknown as WorkflowStep;
    }),
  };
}

export function stepArgv(step: WorkflowStep, env: NodeJS.ProcessEnv, inherited: { yes: boolean }): string[] {
  const argv = splitCommandLine(interpolate(step.run.replace(/^searvia\s+/, ''), env));
  for (const [key, value] of Object.entries(step.with ?? {})) {
    if (value === false || value === null) argv.push(`--no-${key}`);
    else if (value === true) argv.push(`--${key}`);
    else argv.push(`--${key}`, interpolate(Array.isArray(value) ? value.join(',') : String(value), env));
  }
  if ((step.yes ?? inherited.yes) && !argv.includes('--yes') && !argv.includes('-y')) argv.push('--yes');
  return argv;
}

export const workflow: Command = {
  name: 'workflow',
  summary: 'Run a YAML/JSON list of searvia steps (for CI)',
  usage: 'searvia workflow run <file.yml> [--yes] [--list]',
  description:
    // biome-ignore lint/suspicious/noTemplateCurlyInString: documents the workflow ${VAR} syntax
    'Each step is a searvia command line (`run: push --platform ios`) with optional `with:` flags, `yes:`, `continueOnError:` and `if: ${ENV_VAR}` (skipped when empty/false). ${VAR} and ${VAR:-default} are read from the environment and the workflow `env:` map. --yes on `workflow run` applies to every step.',
  options: [{ name: 'list', type: 'boolean', description: 'Print the steps without running them.' }],
  examples: ['searvia workflow run .searvia/release.yml --yes'],
  async run(context) {
    const [action, file] = context.positionals;
    if (action !== 'run' || !file) throw new UsageError('Use `searvia workflow run <file>`.');
    const flow = parseWorkflow(readFileSync(resolve(context.cwd, file), 'utf8'));
    const env = { ...context.env, ...(flow.env ?? {}) };
    for (const [key, value] of Object.entries(flow.env ?? {})) process.env[key] ??= interpolate(value, context.env);
    const results: Array<{ step: string; code: number; skipped?: boolean }> = [];
    context.out.log(context.out.paint('bold', flow.name ?? file));

    for (const [index, step] of flow.steps.entries()) {
      const label = step.name ?? step.run;
      const argv = stepArgv(step, env, { yes: context.apply });
      if (step.if !== undefined) {
        const condition = interpolate(String(step.if), env).trim().toLowerCase();
        if (['', 'false', '0', 'no'].includes(condition)) {
          context.out.log(`\n${context.out.paint('gray', `[${index + 1}/${flow.steps.length}] ${label} (skipped)`)}`);
          results.push({ step: label, code: 0, skipped: true });
          continue;
        }
      }
      context.out.log(`\n${context.out.paint('cyan', `[${index + 1}/${flow.steps.length}]`)} ${label}  ${context.out.paint('gray', `searvia ${argv.join(' ')}`)}`);
      if (context.options.list) {
        results.push({ step: label, code: 0, skipped: true });
        continue;
      }
      const code = await context.run(argv);
      results.push({ step: label, code });
      if (code !== 0 && !step.continueOnError) throw new CliError(`Step ${index + 1} (${label}) failed with exit code ${code}.`, { exitCode: code });
    }
    context.out.success(`Workflow finished: ${results.filter((item) => !item.skipped).length} steps ran.`);
    return { workflow: flow.name ?? file, steps: results };
  },
};
