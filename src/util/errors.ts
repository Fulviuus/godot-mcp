/**
 * Error helpers shared across the server. Tool handlers throw `ToolError` to
 * surface a clean, user-facing message; everything else is wrapped into one by
 * `toToolError` so an agent never sees a raw stack trace.
 */

export class ToolError extends Error {
  /** Optional remediation hint shown to the agent under the message. */
  readonly hint?: string;
  /** Optional machine-readable code (e.g. "ENOENT", "no_project"). */
  readonly code?: string;

  constructor(message: string, options: { hint?: string; code?: string } = {}) {
    super(message);
    this.name = 'ToolError';
    this.hint = options.hint;
    this.code = options.code;
  }
}

/** Convenience constructor used throughout the tool/service code. */
export function fail(message: string, options?: { hint?: string; code?: string }): never {
  throw new ToolError(message, options);
}

/** Normalises any thrown value into a `ToolError` with a readable message. */
export function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return new ToolError(err.message, { code });
  }
  return new ToolError(String(err));
}

/** Renders a ToolError into the text body returned to the model. */
export function renderError(err: ToolError): string {
  const lines = [`Error: ${err.message}`];
  if (err.code) lines.push(`Code: ${err.code}`);
  if (err.hint) lines.push(`Hint: ${err.hint}`);
  return lines.join('\n');
}
