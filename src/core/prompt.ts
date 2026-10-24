import { createInterface } from 'node:readline/promises';

export function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;
}

export async function ask(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question}${fallback ? ` (${fallback})` : ''}: `)).trim();
    return answer || fallback || '';
  } finally {
    rl.close();
  }
}

/** Reads a line without echoing it (API keys). */
export async function askSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const output = rl as unknown as { _writeToOutput?: (text: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  const original = output._writeToOutput?.bind(rl);
  output._writeToOutput = (text: string) => {
    if (!muted || text.includes('\n')) original?.(muted ? '\n' : text);
  };
  try {
    const pending = rl.question(`${question}: `);
    muted = true;
    return (await pending).trim();
  } finally {
    rl.close();
  }
}
