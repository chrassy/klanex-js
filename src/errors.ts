/** Base error for non-2xx API responses. */
export class KlanexError extends Error {
  /** HTTP status of the response. */
  readonly status: number;
  /** Engine error code, e.g. "SCHEMA_INVALID", "NOT_TERMINAL". */
  readonly code: string;
  /** Individual validation problems, when present. */
  readonly problems?: string[];
  /** Agent-facing correction hint, when present. */
  readonly llmHint?: string;

  constructor(args: {
    status: number;
    code: string;
    message: string;
    problems?: string[];
    llmHint?: string;
  }) {
    super(args.message);
    this.name = "KlanexError";
    this.status = args.status;
    this.code = args.code;
    if (args.problems !== undefined) this.problems = args.problems;
    if (args.llmHint !== undefined) this.llmHint = args.llmHint;
  }
}

/**
 * Thrown when the payload fails the JSON Schema gate (HTTP 422).
 * `llmHint` is written to be injected verbatim into the agent's context so
 * it can regenerate a corrected payload.
 */
export class KlanexSchemaError extends KlanexError {
  constructor(args: {
    message: string;
    problems?: string[];
    llmHint?: string;
  }) {
    super({ status: 422, code: "SCHEMA_INVALID", ...args });
    this.name = "KlanexSchemaError";
  }
}

/** Thrown when a webhook fails signature or timestamp verification. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}
