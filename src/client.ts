import { KlanexError, KlanexSchemaError } from "./errors.js";
import type {
  ExecuteRequest,
  ExecuteResponse,
  Execution,
  ExecutionStatus,
  ReplayResponse,
} from "./types.js";

export interface KlanexOptions {
  /** Tenant API key ("klx_..."). */
  apiKey: string;
  /** Ingest service base URL, e.g. "https://klanex-ingest-....run.app". */
  baseUrl: string;
  /** Custom fetch (for testing or non-global environments). */
  fetch?: typeof globalThis.fetch;
}

export interface WaitOptions {
  /** Poll interval in ms (default 2000). */
  pollIntervalMs?: number;
  /** Give up after this long (default 120000). */
  timeoutMs?: number;
}

const TERMINAL: ReadonlySet<ExecutionStatus> = new Set(["SUCCEEDED", "FAILED"]);

export class Klanex {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: KlanexOptions) {
    if (!options.apiKey) throw new Error("klanex: apiKey is required");
    if (!options.baseUrl) throw new Error("klanex: baseUrl is required");
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /**
   * Submit a tool-use intent for asynchronous execution. Resolves as soon as
   * the engine has validated and queued it (202) or matched an idempotency
   * key (200). Throws KlanexSchemaError when the payload fails the schema
   * gate — feed `error.llmHint` back to your agent and resubmit.
   */
  async execute(request: ExecuteRequest): Promise<ExecuteResponse> {
    const body: Record<string, unknown> = {
      target: {
        method: request.target.method,
        url: request.target.url,
        headers: request.target.headers,
        timeout_ms: request.target.timeoutMs,
      },
      payload: request.payload,
      payload_schema: request.payloadSchema,
      callback_url: request.callbackUrl,
      max_attempts: request.maxAttempts,
      idempotency_key: request.idempotencyKey,
    };
    const res = await this.#request("POST", "/v1/executions", body);
    const data = (await res.json()) as { execution_id: string; status: ExecutionStatus };
    return {
      executionId: data.execution_id,
      status: data.status,
      idempotentReplay: res.headers.get("X-Klanex-Idempotent-Replay") === "true",
    };
  }

  /** Fetch the current state of an execution. Credentials are redacted. */
  async get(executionId: string): Promise<Execution> {
    const res = await this.#request("GET", `/v1/executions/${encodeURIComponent(executionId)}`);
    return toExecution(await res.json());
  }

  /**
   * Re-run a terminal execution with its byte-exact original payload and
   * sealed credentials. Returns the new execution. Not idempotent: every
   * call creates a fresh execution.
   */
  async replay(executionId: string): Promise<ReplayResponse> {
    const res = await this.#request(
      "POST",
      `/v1/executions/${encodeURIComponent(executionId)}/replay`,
    );
    const data = (await res.json()) as {
      execution_id: string;
      status: ExecutionStatus;
      replay_of: string;
    };
    return { executionId: data.execution_id, status: data.status, replayOf: data.replay_of };
  }

  /**
   * Poll until the execution reaches a terminal state (SUCCEEDED or FAILED)
   * and return it. Prefer webhooks in production; this is convenient for
   * scripts and tests. Throws on timeout.
   */
  async waitForResult(executionId: string, options: WaitOptions = {}): Promise<Execution> {
    const interval = options.pollIntervalMs ?? 2000;
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    for (;;) {
      const execution = await this.get(executionId);
      if (TERMINAL.has(execution.status)) return execution;
      if (Date.now() + interval > deadline) {
        throw new KlanexError({
          status: 0,
          code: "WAIT_TIMEOUT",
          message: `execution ${executionId} still ${execution.status} after ${options.timeoutMs ?? 120_000}ms`,
        });
      }
      await sleep(interval);
    }
  }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.#fetch(this.#baseUrl + path, {
      method,
      headers: {
        "X-API-Key": this.#apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.ok) return res;
    throw await toError(res);
  }
}

async function toError(res: Response): Promise<KlanexError> {
  let code = "UNKNOWN";
  let message = `klanex API returned ${res.status}`;
  let problems: string[] | undefined;
  let llmHint: string | undefined;
  try {
    const data = (await res.json()) as {
      error?: { code?: string; message?: string; problems?: string[]; llm_hint?: string };
    };
    code = data.error?.code ?? code;
    message = data.error?.message ?? message;
    problems = data.error?.problems;
    llmHint = data.error?.llm_hint;
  } catch {
    // non-JSON error body; keep defaults
  }
  if (res.status === 422 && code === "SCHEMA_INVALID") {
    return new KlanexSchemaError({
      message,
      ...(problems !== undefined ? { problems } : {}),
      ...(llmHint !== undefined ? { llmHint } : {}),
    });
  }
  return new KlanexError({
    status: res.status,
    code,
    message,
    ...(problems !== undefined ? { problems } : {}),
    ...(llmHint !== undefined ? { llmHint } : {}),
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toExecution(raw: any): Execution {
  const execution: Execution = {
    executionId: raw.execution_id,
    status: raw.status,
    attempts: raw.attempts,
    maxAttempts: raw.max_attempts,
    target: {
      url: raw.target?.url,
      method: raw.target?.method,
      headers: raw.target?.headers,
      timeoutMs: raw.target?.timeout_ms,
    },
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
  if (raw.callback_url) execution.callbackUrl = raw.callback_url;
  if (raw.replay_of) execution.replayOf = raw.replay_of;
  if (raw.result) {
    execution.result = { statusCode: raw.result.status_code, body: raw.result.body };
  }
  if (raw.error) {
    execution.error = {
      code: raw.error.code,
      message: raw.error.message,
      ...(raw.error.llm_hint ? { llmHint: raw.error.llm_hint } : {}),
    };
  }
  return execution;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
