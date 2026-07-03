/** Lifecycle state of an execution. */
export type ExecutionStatus =
  | "QUEUED"
  | "RUNNING"
  | "RETRYING"
  | "SUCCEEDED"
  | "FAILED";

/**
 * Error classification returned by the engine. Retryable codes are handled
 * by klanex itself; `SCHEMA_INVALID` and `TARGET_REJECTED` carry an
 * `llmHint` meant to be fed back into the agent's context.
 */
export type ErrorCode =
  | "SCHEMA_INVALID"
  | "TARGET_TIMEOUT"
  | "TARGET_RATE_LIMITED"
  | "TARGET_UNAVAILABLE"
  | "TARGET_REJECTED"
  | "CIRCUIT_OPEN"
  | "ATTEMPTS_EXHAUSTED"
  | "INTERNAL";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The third-party API call the agent wants executed. */
export interface Target {
  /** Defaults to POST on the server. */
  method?: HttpMethod;
  /** Absolute http(s) URL. */
  url: string;
  /** Your third-party credentials; encrypted at rest by the engine. */
  headers?: Record<string, string>;
  /** Per-attempt timeout in ms (default 30000, max 120000). */
  timeoutMs?: number;
}

export interface ExecuteRequest {
  target: Target;
  /** The agent-generated JSON body. Sent byte-exact after serialization. */
  payload?: unknown;
  /** JSON Schema; hallucinated payloads are rejected synchronously (422). */
  payloadSchema?: unknown;
  /** Webhook destination for the terminal event. */
  callbackUrl?: string;
  /** 1..10, default 5. */
  maxAttempts?: number;
  /** Tenant-scoped; makes retries of this call safe (≤255 chars). */
  idempotencyKey?: string;
}

export interface ExecuteResponse {
  executionId: string;
  status: ExecutionStatus;
  /** True when an idempotency key matched a previous submission. */
  idempotentReplay: boolean;
}

export interface ReplayResponse {
  executionId: string;
  status: ExecutionStatus;
  replayOf: string;
}

export interface ExecutionError {
  code: ErrorCode;
  message: string;
  /** Paste this into your agent's context so it can self-correct. */
  llmHint?: string;
}

export interface ExecutionResult {
  statusCode: number;
  /** Target response body, truncated to the engine's storage limit. */
  body: string;
}

export interface Execution {
  executionId: string;
  status: ExecutionStatus;
  attempts: number;
  maxAttempts: number;
  target: Target;
  callbackUrl?: string;
  result?: ExecutionResult;
  error?: ExecutionError;
  /** Present when this execution was created via replay. */
  replayOf?: string;
  createdAt: string;
  updatedAt: string;
}

export type WebhookEventName = "execution.completed" | "execution.failed";

/** Body of the signed webhook klanex POSTs to your callback URL. */
export interface WebhookEvent {
  event: WebhookEventName;
  executionId: string;
  status: ExecutionStatus;
  attempts: number;
  result?: ExecutionResult;
  error?: ExecutionError;
}
