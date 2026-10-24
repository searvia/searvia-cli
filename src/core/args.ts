import { UsageError } from './errors.js';

export type OptionType = 'boolean' | 'string' | 'number' | 'list';

export interface OptionSpec {
  name: string;
  alias?: string;
  type: OptionType;
  description: string;
  /** Placeholder shown in help, e.g. `<locale>`. */
  value?: string;
  default?: unknown;
}

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, unknown>;
}

/** Options every command accepts. */
export const GLOBAL_OPTIONS: OptionSpec[] = [
  { name: 'json', type: 'boolean', description: 'Machine-readable output on stdout (logs go to stderr).' },
  { name: 'yes', alias: 'y', type: 'boolean', description: 'Apply changes. Without it, writes are a dry run that prints the diff.' },
  { name: 'config', type: 'string', value: '<file>', description: 'Config file (default: searvia.config.json, then .searvia/config.json).' },
  { name: 'verbose', type: 'boolean', description: 'Log every API request.' },
  { name: 'no-color', type: 'boolean', description: 'Disable colors (also NO_COLOR=1).' },
  { name: 'help', alias: 'h', type: 'boolean', description: 'Show help.' },
];

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Small, strict argument parser: `--name value`, `--name=value`, `-y`, `--no-flag`, repeated or comma-separated lists,
 * and `--` to stop option parsing. Unknown options are a usage error so typos never silently do nothing.
 */
export function parseArgs(argv: string[], specs: OptionSpec[]): ParsedArgs {
  const all = [...specs, ...GLOBAL_OPTIONS];
  const byName = new Map(all.map((spec) => [spec.name, spec]));
  const byAlias = new Map(all.filter((spec) => spec.alias).map((spec) => [spec.alias as string, spec]));
  const options: Record<string, unknown> = {};
  const positionals: string[] = [];

  for (const spec of all) {
    if (spec.default !== undefined) options[camel(spec.name)] = spec.default;
  }

  const assign = (spec: OptionSpec, raw: string | undefined, negated = false) => {
    const key = camel(spec.name);
    switch (spec.type) {
      case 'boolean':
        if (raw === undefined) options[key] = !negated;
        else if (/^(true|1|yes)$/i.test(raw)) options[key] = true;
        else if (/^(false|0|no)$/i.test(raw)) options[key] = false;
        else throw new UsageError(`--${spec.name} takes no value (got "${raw}").`);
        return;
      case 'number': {
        const value = Number(raw);
        if (raw === undefined || raw === '' || Number.isNaN(value)) throw new UsageError(`--${spec.name} needs a number.`);
        options[key] = value;
        return;
      }
      case 'list': {
        if (raw === undefined) throw new UsageError(`--${spec.name} needs a value.`);
        const previous = Array.isArray(options[key]) && options[key] !== spec.default ? (options[key] as string[]) : [];
        options[key] = [
          ...previous,
          ...raw
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        ];
        return;
      }
      default:
        if (raw === undefined) throw new UsageError(`--${spec.name} needs a value.`);
        options[key] = raw;
    }
  };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string;

    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith('--')) {
      const [rawName, inline] = token.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      let spec = byName.get(rawName);
      let negated = false;
      if (!spec && rawName.startsWith('no-')) {
        const positive = byName.get(rawName.slice(3));
        if (positive?.type === 'boolean') {
          spec = positive;
          negated = true;
        }
      }
      if (!spec) throw new UsageError(`Unknown option --${rawName}.`, 'Run the command with --help to see its options.');
      if (spec.type === 'boolean' || inline !== undefined) {
        assign(spec, inline, negated);
      } else {
        const value = argv[index + 1];
        if (value === undefined || (value.startsWith('--') && value.length > 2)) throw new UsageError(`--${spec.name} needs a value.`);
        assign(spec, value);
        index++;
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)) {
      for (const letter of token.slice(1)) {
        const spec = byAlias.get(letter);
        if (!spec) throw new UsageError(`Unknown option -${letter}.`);
        if (spec.type === 'boolean') assign(spec, undefined);
        else {
          const value = argv[index + 1];
          if (value === undefined) throw new UsageError(`-${letter} needs a value.`);
          assign(spec, value);
          index++;
        }
      }
      continue;
    }

    positionals.push(token);
  }

  return { positionals, options };
}

/** Splits a command line like a POSIX shell would for simple cases: spaces, single and double quotes, backslashes. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index] as string;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && index + 1 < line.length) current += line[++index];
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === '\\' && index + 1 < line.length) {
      current += line[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) out.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new UsageError(`Unclosed quote in: ${line}`);
  if (started) out.push(current);
  return out;
}

export function renderOptions(specs: OptionSpec[]): string {
  const rows = specs.map((spec) => {
    const flag = `${spec.alias ? `-${spec.alias}, ` : '    '}--${spec.name}${spec.type === 'boolean' ? '' : ` ${spec.value ?? '<value>'}`}`;
    return [flag, spec.description] as const;
  });
  const width = Math.min(34, Math.max(...rows.map(([flag]) => flag.length)) + 2);
  return rows.map(([flag, text]) => `  ${flag.padEnd(width)}${text}`).join('\n');
}
