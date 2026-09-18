/**
 * OpenAI Agents SDK adapter: `import { klanexTool } from "klanex-sdk/openai-agents"`.
 *
 * Wraps an API call as a function tool whose arguments are the payload.
 * klanex owns the call's reliability (schema gate, retries, backoff, circuit
 * breakers, approvals, credentials), and the tool returns text for the model.
 */
import { tool, type FunctionTool } from "@openai/agents";

import type { Klanex } from "./client.js";
import { isPlainJsonSchema } from "./adapters/schema.js";
import { runKlanexTool, type KlanexToolConfig } from "./tool.js";

export type { KlanexToolConfig } from "./tool.js";

export interface KlanexAgentsToolOptions extends KlanexToolConfig {
  /** Tool name, unique within the agent. */
  name: string;
  /** Tells the model what the tool does and when to use it. */
  description: string;
  /**
   * The tool arguments, which become the request payload: a Zod object, or
   * a plain JSON Schema object. Plain JSON Schemas are not validated by the
   * Agents SDK, so klanex's schema gate enforces them and a failing input
   * comes back to the model as a correction hint.
   */
  parameters: unknown;
  /**
   * OpenAI strict mode. Defaults to true for Zod (which the SDK requires)
   * and false for plain JSON Schemas, which rarely meet strict-mode rules.
   */
  strict?: boolean;
}

/**
 * Create an OpenAI Agents SDK function tool backed by klanex.
 *
 * ```ts
 * const refund = klanexTool(klanex, {
 *   name: "create_refund",
 *   description: "Refund a Stripe charge",
 *   parameters: z.object({ charge: z.string(), amount: z.number().int() }),
 *   target: { url: "https://api.stripe.com/v1/refunds", connectionId: "con_..." },
 * });
 * const agent = new Agent({ name: "Support", tools: [refund] });
 * ```
 */
export function klanexTool(client: Klanex, options: KlanexAgentsToolOptions): FunctionTool {
  const { name, description, parameters, strict, ...config } = options;
  const plain = isPlainJsonSchema(parameters);
  // The SDK's overloads split strict and non-strict schema types; the
  // runtime accepts either, so resolve the combination here.
  return tool({
    name,
    description,
    parameters: parameters as never,
    strict: (strict ?? !plain) as never,
    execute: (input: unknown, _context?: unknown, details?: { toolCall?: { callId?: string }; signal?: AbortSignal }) =>
      runKlanexTool(client, config, input, {
        toolName: name,
        toolCallId: details?.toolCall?.callId,
        signal: details?.signal,
        ...(plain ? { payloadSchema: parameters } : {}),
      }),
  }) as unknown as FunctionTool;
}
