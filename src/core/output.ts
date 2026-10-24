export interface OutputOptions {
  json?: boolean;
  color?: boolean;
  verbose?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

const codes = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90, bold: 1, dim: 2 } as const;
type Color = keyof typeof codes;

/**
 * Human output goes to stdout; with `--json` only the final JSON document is written to stdout and progress lines go
 * to stderr, so `searvia audit --json | jq` always parses.
 */
export class Output {
  readonly json: boolean;
  readonly verbose: boolean;
  private readonly color: boolean;
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;

  constructor(options: OutputOptions = {}) {
    this.json = options.json ?? false;
    this.verbose = options.verbose ?? false;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.color = options.color ?? (Boolean((this.stdout as { isTTY?: boolean }).isTTY) && !process.env.NO_COLOR);
  }

  paint(color: Color, text: string): string {
    return this.color ? `\u001b[${codes[color]}m${text}\u001b[0m` : text;
  }

  /** A normal line (suppressed on stdout in JSON mode). */
  log(text = ''): void {
    if (this.json) return;
    this.stdout.write(`${text}\n`);
  }

  /** Progress: stdout normally, stderr in JSON mode. */
  step(text: string): void {
    const line = `${this.paint('cyan', '›')} ${text}\n`;
    (this.json ? this.stderr : this.stdout).write(this.json ? `› ${text}\n` : line);
  }

  success(text: string): void {
    (this.json ? this.stderr : this.stdout).write(`${this.paint('green', '✓')} ${text}\n`);
  }

  warn(text: string): void {
    this.stderr.write(`${this.paint('yellow', '!')} ${text}\n`);
  }

  error(text: string): void {
    this.stderr.write(`${this.paint('red', '✗')} ${text}\n`);
  }

  debug(text: string): void {
    if (this.verbose) this.stderr.write(`${this.paint('gray', `  ${text}`)}\n`);
  }

  /** The command result: pretty JSON in JSON mode, nothing otherwise (commands print their own human view). */
  result(value: unknown): void {
    if (this.json) this.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }

  table(rows: Array<Record<string, unknown>>, columns: string[], headers?: string[]): void {
    if (this.json || rows.length === 0) return;
    const head = headers ?? columns;
    const cells = rows.map((row) => columns.map((column) => format(row[column])));
    const widths = head.map((title, index) => Math.min(60, Math.max(title.length, ...cells.map((line) => (line[index] ?? '').length))));
    const render = (line: string[]) =>
      line
        .map((cell, index) => truncate(cell, widths[index] as number).padEnd(widths[index] as number))
        .join('  ')
        .trimEnd();
    this.log(this.paint('bold', render(head)));
    for (const line of cells) this.log(render(line));
  }
}

function format(value: unknown): string {
  if (value === null || value === undefined) return '–';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function truncate(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}
