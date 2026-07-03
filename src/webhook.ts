import { createHmac, timingSafeEqual } from "node:crypto";

import { WebhookVerificationError } from "./errors.js";
import type { ErrorCode, WebhookEvent } from "./types.js";

/** Header names used on klanex webhook deliveries. */
export const WEBHOOK_HEADERS = {
  signature: "X-Klanex-Signature",
  timestamp: "X-Klanex-Timestamp",
  event: "X-Klanex-Event",
  executionId: "X-Klanex-Execution-Id",
} as const;

export interface VerifyWebhookOptions {
  /** Your tenant webhook secret ("whsec_..."). */
  secret: string;
  /** Raw request body, exactly as received (do not re-serialize JSON). */
  body: string | Uint8Array;
  /** Value of the X-Klanex-Signature header. */
  signature: string;
  /** Value of the X-Klanex-Timestamp header (unix seconds). */
  timestamp: number | string;
  /** Reject deliveries older than this (default 300s). 0 disables. */
  toleranceSeconds?: number;
  /** Injectable clock for testing (unix seconds). */
  now?: number;
}

/**
 * Compute the signature for a body at a timestamp:
 * "sha256=" + hex(HMAC-SHA256(secret, `${timestamp}.${body}`)).
 * Matches the engine's Go implementation byte for byte.
 */
export function signWebhook(
  secret: string,
  timestamp: number,
  body: string | Uint8Array,
): string {
  const mac = createHmac("sha256", secret);
  mac.update(`${timestamp}.`);
  mac.update(body);
  return `sha256=${mac.digest("hex")}`;
}

/**
 * Verify a webhook delivery and return the parsed event. Throws
 * WebhookVerificationError on a bad signature, a stale timestamp, or an
 * unparseable body. Always pass the raw body bytes — re-serializing the
 * parsed JSON will break the signature.
 */
export function verifyWebhook(options: VerifyWebhookOptions): WebhookEvent {
  const ts = Number(options.timestamp);
  if (!Number.isFinite(ts)) {
    throw new WebhookVerificationError("invalid timestamp header");
  }

  const tolerance = options.toleranceSeconds ?? 300;
  if (tolerance > 0) {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > tolerance) {
      throw new WebhookVerificationError(
        `timestamp outside tolerance (${Math.abs(now - ts)}s > ${tolerance}s); possible replay`,
      );
    }
  }

  const expected = Buffer.from(signWebhook(options.secret, ts, options.body));
  const received = Buffer.from(options.signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new WebhookVerificationError("signature mismatch");
  }

  const text =
    typeof options.body === "string" ? options.body : Buffer.from(options.body).toString("utf8");
  let raw: {
    event: WebhookEvent["event"];
    execution_id: string;
    status: WebhookEvent["status"];
    attempts: number;
    result?: { status_code: number; body: string };
    error?: { code: string; message: string; llm_hint?: string };
  };
  try {
    raw = JSON.parse(text);
  } catch {
    throw new WebhookVerificationError("body is not valid JSON");
  }

  const event: WebhookEvent = {
    event: raw.event,
    executionId: raw.execution_id,
    status: raw.status,
    attempts: raw.attempts,
  };
  if (raw.result) {
    event.result = { statusCode: raw.result.status_code, body: raw.result.body };
  }
  if (raw.error) {
    event.error = {
      code: raw.error.code as ErrorCode,
      message: raw.error.message,
      ...(raw.error.llm_hint ? { llmHint: raw.error.llm_hint } : {}),
    };
  }
  return event;
}
