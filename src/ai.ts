/**
 * Vercel AI SDK adapter: `import { klanexTool } from "klanex/ai"`.
 *
 * Wraps an API call as an AI SDK tool whose input is the payload. klanex owns
 * the call's reliability (schema gate, retries, backoff, circuit breakers,
 * approvals, credentials), and the tool resolves with text for the model.
 */
import { jsonSchema, tool, type Tool } from "ai";

import type { Klanex } from "./client.js";
import { isPlainJsonSchema } from "./adapters/schema.js";
import { runKlanexTool, type KlanexToolConfig } from "./tool.js";

export type { KlanexToolConfig } from "./tool.js";

export interface KlanexAiToolOptions<INPUT> extends KlanexToolConfig {
  /** Tells the model what the tool does and when to use it. */
  description: string;
  /**
   * The tool input, which becomes the request payload: a Zod or other
   * Standard Schema, an AI SDK `jsonSchema(...)`, or a plain JSON Schema
   * object. Plain JSON Schemas are also enforced by klanex's schema gate,
   * and a failing input comes back to the model as a correction hint.
   */
  inputSchema: object;
  /** Used in the idempotency key and klanex audit trail (default "tool"). */
  name?: string;
}

/**
 * Create an AI SDK tool backed by klanex.
 *
 * ```ts
 * const refund = klanexTool(klanex, {
 *   description: "Refund a Stripe charge",
 *   inputSchema: z.object({ charge: z.string(), amount: z.number().int() }),
 *   target: { url: "https://api.stripe.com/v1/refunds", connectionId: "con_..." },
 * });
 * await generateText({ model, tools: { refund }, prompt });
 * ```
 */
export function klanexTool<INPUT = unknown>(
  client: Klanex,
  options: KlanexAiToolOptions<INPUT>,
): Tool<INPUT, string> {
  const { description, inputSchema, name, ...config } = options;
  const plain = isPlainJsonSchema(inputSchema);
  // Typed loosely on purpose: tool()'s generics differ across AI SDK 5, 6
  // and 7, while the runtime contract used here is the same in all three.
  return tool({
    description,
    inputSchema: (plain ? jsonSchema(inputSchema as never) : inputSchema) as never,
    execute: (input: INPUT, { toolCallId, abortSignal }: { toolCallId: string; abortSignal?: AbortSignal }) =>
      runKlanexTool(client, config, input, {
        toolName: name ?? "tool",
        toolCallId,
        signal: abortSignal,
        ...(plain ? { payloadSchema: inputSchema } : {}),
      }),
  } as never) as Tool<INPUT, string>;
}
