/** An error the CLI reports without a stack trace. `exitCode` 2 = usage, 3 = audit threshold, 1 = anything else. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(message: string, options: { exitCode?: number; hint?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = options.exitCode ?? 1;
    this.hint = options.hint;
    this.details = options.details;
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: 2, hint });
    this.name = 'UsageError';
  }
}

/** An HTTP API answered with an error status. */
export class ApiError extends CliError {
  readonly status: number;
  readonly service: string;

  constructor(service: string, status: number, message: string, details?: unknown, hint?: string) {
    super(`${service}: ${message}`, { details, hint });
    this.name = 'ApiError';
    this.status = status;
    this.service = service;
  }
}
