#!/usr/bin/env node
import { main } from './cli.js';

const [major] = process.versions.node.split('.').map(Number);
if ((major ?? 0) < 20) {
  process.stderr.write(`searvia needs Node.js 20 or newer (this is ${process.versions.node}).\n`);
  process.exit(1);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  },
);
