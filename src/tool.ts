// Framework-agnostic core of the agent-framework adapters (klanex/ai,
// klanex/openai-agents). It deliberately imports only the client and errors,
// never node:crypto, so the adapters also run on edge runtimes.
import type { Klanex } from "./client.js";
import { KlanexError, KlanexSchemaError } from "./errors.js";
import type { Target } from "./types.js";

/** How a klanex-backed tool executes. The model's tool input is the payload. */
export interface KlanexToolConfig {
  /** The API call to make. The model never sees the URL or credentials. */
  target: Target;
  /** Pause each call for a human decision (Slack or dashboard) before it runs. */
  requiresApproval?: boolean;
  /** Attempts before giving up on retryable failures, 1..10 (default 5). */
  maxAttempts?: number;
  /**
   * How long one tool call waits for the result, in ms (default 120000). On
   * timeout the model is told the action is still running, never to retry.
   */
  waitTimeoutMs?: number;
  /** Poll interval while waiting, in ms (default 2000). */
  pollIntervalMs?: number;
  /**
   * Derive an idempotency key from the framework's tool call ID, so a re-run
   * of the same tool call (a resumed or retried agent step) never executes
   * the action twice. Default true.
   */
  idempotency?: boolean;
}

/** Per-call details the adapters pass in from their framework. */
export interface ToolCall {
  toolName: string;
  toolCallId?: string | undefined;
  signal?: AbortSignal | undefined;
  /** JSON Schema of the tool input, sent as the server-side payload gate. */
  payloadSchema?: unknown;
}

const MAX_IDEMPOTENCY_KEY = 255;

/**
 * Execute one tool call through klanex and return text for the model: the
 * target's response on success, or the correction hint on failure, so the
 * agent can react instead of crashing. Errors unrelated to the call itself
 * (bad API key, quota, network) are thrown for the framework to surface.
 */
export async function runKlanexTool(
  client: Klanex,
  config: KlanexToolConfig,
  input: unknown,
  call: ToolCall,
): Promise<string> {
  let accepted;
  try {
    accepted = await client.execute({
      target: config.target,
      payload: input,
      ...(call.payloadSchema !== undefined ? { payloadSchema: call.payloadSchema } : {}),
      ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}),
      ...(config.requiresApproval ? { requiresApproval: true } : {}),
      ...idempotencyKey(config, call),
    });
  } catch (err) {
    // The self-correction loop: the schema hint goes straight back to the model.
    if (err instanceof KlanexSchemaError) return err.llmHint ?? `Invalid input: ${err.message}`;
    throw err;
  }

  if (accepted.status === "PENDING_APPROVAL") {
    return (
      `Submitted for human approval (execution ${accepted.executionId}). ` +
      "The action runs once a reviewer approves it; do not call this tool again for it."
    );
  }

  let execution;
  try {
    execution = await client.waitForResult(accepted.executionId, {
      ...(config.waitTimeoutMs !== undefined ? { timeoutMs: config.waitTimeoutMs } : {}),
      ...(config.pollIntervalMs !== undefined ? { pollIntervalMs: config.pollIntervalMs } : {}),
      ...(call.signal ? { signal: call.signal } : {}),
    });
  } catch (err) {
    if (err instanceof KlanexError && err.code === "WAIT_TIMEOUT") {
      return (
        `The action was accepted and is still running (execution ${accepted.executionId}); ` +
        "klanex keeps retrying it in the background. Do not call this tool again for the " +
        "same action, or it may be performed twice. Tell the user it is in progress."
      );
    }
    throw err;
  }

  if (execution.status === "SUCCEEDED") {
    const result = execution.result;
    const body = result?.body || `(empty response, HTTP ${result?.statusCode ?? "2xx"})`;
    return result?.note ? `${result.note}\n\nTarget response: ${body}` : body;
  }
  const error = execution.error;
  if (error?.llmHint) return error.llmHint;
  return `The tool call failed (${error?.code ?? "UNKNOWN"}): ${error?.message ?? "no details"}`;
}

function idempotencyKey(config: KlanexToolConfig, call: ToolCall): { idempotencyKey?: string } {
  if (config.idempotency === false || !call.toolCallId) return {};
  const key = `tool:${call.toolName}:${call.toolCallId}`;
  // Keep the unique tail (the call ID) if an unusually long name overflows.
  return { idempotencyKey: key.length > MAX_IDEMPOTENCY_KEY ? key.slice(-MAX_IDEMPOTENCY_KEY) : key };
}
