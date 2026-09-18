import { RunContext } from "@openai/agents";
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Klanex } from "../src/index.js";
import { klanexTool as aiTool } from "../src/ai.js";
import { klanexTool as agentsTool } from "../src/openai-agents.js";
import { runKlanexTool } from "../src/tool.js";

type Reply = { status: number; body: unknown };
type Call = { url: string; method: string; body: any };

/** A fake klanex API answering submits and polls in order (last one repeats). */
function fakeKlanex(...replies: Reply[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = replies[Math.min(i++, replies.length - 1)]!;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  const client = new Klanex({ apiKey: "klx_test", fetch: fetch as typeof globalThis.fetch });
  return { client, calls };
}

const TARGET = { url: "https://api.stripe.com/v1/refunds", connectionId: "con_1" };
const queued = { status: 202, body: { execution_id: "exe_1", status: "QUEUED" } };
const execution = (fields: Record<string, unknown>) => ({
  status: 200,
  body: {
    execution_id: "exe_1", attempts: 1, max_attempts: 5, target: TARGET,
    created_at: "", updated_at: "", ...fields,
  },
});
const succeeded = execution({ status: "SUCCEEDED", result: { status_code: 200, body: '{"id":"re_1"}' } });
const fast = { pollIntervalMs: 1 };

describe("runKlanexTool", () => {
  it("submits the input as the payload with a tool-call idempotency key", async () => {
    const { client, calls } = fakeKlanex(queued, succeeded);
    const out = await runKlanexTool(client, { target: TARGET, ...fast }, { charge: "ch_1" }, {
      toolName: "refund", toolCallId: "call_9",
    });
    expect(out).toBe('{"id":"re_1"}');
    expect(calls[0]!.url).toBe("https://api.klanexai.com/v1/executions");
    expect(calls[0]!.body).toMatchObject({
      target: { url: TARGET.url, connection_id: "con_1" },
      payload: { charge: "ch_1" },
      idempotency_key: "tool:refund:call_9",
    });
  });

  it("skips the idempotency key when disabled or without a call ID", async () => {
    for (const [config, call] of [
      [{ idempotency: false }, { toolCallId: "call_9" }],
      [{}, {}],
    ] as const) {
      const { client, calls } = fakeKlanex(queued, succeeded);
      await runKlanexTool(client, { target: TARGET, ...fast, ...config }, {}, { toolName: "t", ...call });
      expect(calls[0]!.body.idempotency_key).toBeUndefined();
    }
  });

  it("returns the schema hint so the model can correct itself", async () => {
    const { client } = fakeKlanex({
      status: 422,
      body: { error: { code: "SCHEMA_INVALID", message: "bad", llm_hint: "Add charge and resubmit." } },
    });
    expect(await runKlanexTool(client, { target: TARGET }, {}, { toolName: "t" })).toBe("Add charge and resubmit.");
  });

  it("returns the failure hint, or the code and message without one", async () => {
    const hinted = fakeKlanex(queued, execution({
      status: "FAILED",
      error: { code: "TARGET_REJECTED", message: "400", llm_hint: "Fix `amount`.", diagnosis: { cause: "invalid_payload", field: "amount" } },
    }));
    expect(await runKlanexTool(hinted.client, { target: TARGET, ...fast }, {}, { toolName: "t" })).toBe("Fix `amount`.");

    const bare = fakeKlanex(queued, execution({ status: "FAILED", error: { code: "INTERNAL", message: "boom" } }));
    expect(await runKlanexTool(bare.client, { target: TARGET, ...fast }, {}, { toolName: "t" })).toBe(
      "The tool call failed (INTERNAL): boom",
    );
  });

  it("explains a success counted from a duplicate", async () => {
    const { client } = fakeKlanex(queued, execution({
      status: "SUCCEEDED",
      result: { status_code: 409, body: "already exists", note: "Attempt 1 most likely performed it." },
    }));
    expect(await runKlanexTool(client, { target: TARGET, ...fast }, {}, { toolName: "t" })).toBe(
      "Attempt 1 most likely performed it.\n\nTarget response: already exists",
    );
  });

  it("tells the model not to resubmit while pending approval or still running", async () => {
    const pending = fakeKlanex({ status: 202, body: { execution_id: "exe_1", status: "PENDING_APPROVAL" } });
    const out = await runKlanexTool(pending.client, { target: TARGET, requiresApproval: true }, {}, { toolName: "t" });
    expect(out).toContain("human approval");
    expect(pending.calls[0]!.body.requires_approval).toBe(true);

    const running = fakeKlanex(queued, execution({ status: "RETRYING" }));
    const late = await runKlanexTool(running.client, { target: TARGET, pollIntervalMs: 1, waitTimeoutMs: 5 }, {}, { toolName: "t" });
    expect(late).toContain("still running (execution exe_1)");
    expect(late).toContain("Do not call this tool again");
  });

  it("throws errors that are not about the call", async () => {
    const { client } = fakeKlanex({ status: 401, body: { error: { code: "UNAUTHORIZED", message: "bad key" } } });
    await expect(runKlanexTool(client, { target: TARGET }, {}, { toolName: "t" })).rejects.toThrow("bad key");
  });

  it("stops waiting when aborted", async () => {
    const { client } = fakeKlanex(queued, execution({ status: "RUNNING" }));
    const controller = new AbortController();
    const run = runKlanexTool(client, { target: TARGET, pollIntervalMs: 50 }, {}, { toolName: "t", signal: controller.signal });
    controller.abort(new Error("user cancelled"));
    await expect(run).rejects.toThrow("user cancelled");
  });
});

describe("Vercel AI SDK", () => {
  /** A model that calls `refund` once, then answers with text. */
  function model(input: unknown) {
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    return new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{ type: "tool-call", toolCallId: "call_ai", toolName: "refund", input: JSON.stringify(input) }],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        },
        {
          content: [{ type: "text", text: "Refunded." }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        },
      ],
    } as never);
  }

  it("runs a Zod tool through generateText", async () => {
    const { client, calls } = fakeKlanex(queued, succeeded);
    const refund = aiTool(client, {
      name: "refund",
      description: "Refund a charge",
      inputSchema: z.object({ charge: z.string() }),
      target: TARGET,
      ...fast,
    });
    const result = await generateText({
      model: model({ charge: "ch_1" }),
      tools: { refund },
      stopWhen: stepCountIs(3),
      prompt: "refund ch_1",
    });
    expect(result.steps[0]!.toolResults[0]!.output).toBe('{"id":"re_1"}');
    expect(result.text).toBe("Refunded.");
    // The SDK already validated Zod input; no server-side gate is sent.
    expect(calls[0]!.body).toMatchObject({ payload: { charge: "ch_1" }, idempotency_key: "tool:refund:call_ai" });
    expect(calls[0]!.body.payload_schema).toBeUndefined();
  });

  it("sends a plain JSON Schema to klanex's schema gate", async () => {
    const schema = { type: "object", properties: { charge: { type: "string" } }, required: ["charge"] };
    const { client, calls } = fakeKlanex(queued, succeeded);
    const refund = aiTool(client, { description: "Refund", inputSchema: schema, target: TARGET, ...fast });
    await generateText({ model: model({ charge: "ch_1" }), tools: { refund }, stopWhen: stepCountIs(3), prompt: "x" });
    expect(calls[0]!.body.payload_schema).toEqual(schema);
  });
});

describe("OpenAI Agents SDK", () => {
  it("runs a Zod tool through the SDK's invoke path", async () => {
    const { client, calls } = fakeKlanex(queued, succeeded);
    const refund = agentsTool(client, {
      name: "create_refund",
      description: "Refund a charge",
      parameters: z.object({ charge: z.string() }),
      target: TARGET,
      ...fast,
    });
    expect(refund.strict).toBe(true);
    const out = await refund.invoke(new RunContext(), JSON.stringify({ charge: "ch_1" }), {
      toolCall: { type: "function_call", callId: "call_oa", name: "create_refund", arguments: "{}" },
    } as never);
    expect(out).toBe('{"id":"re_1"}');
    expect(calls[0]!.body).toMatchObject({ payload: { charge: "ch_1" }, idempotency_key: "tool:create_refund:call_oa" });
    expect(calls[0]!.body.payload_schema).toBeUndefined();
  });

  it("uses non-strict mode and the schema gate for a plain JSON Schema", async () => {
    const schema = { type: "object", properties: { charge: { type: "string" } }, required: ["charge"], additionalProperties: true };
    const { client, calls } = fakeKlanex(
      { status: 422, body: { error: { code: "SCHEMA_INVALID", message: "bad", llm_hint: "Add charge." } } },
    );
    const refund = agentsTool(client, { name: "refund", description: "Refund", parameters: schema, target: TARGET });
    expect(refund.strict).toBe(false);
    expect(await refund.invoke(new RunContext(), "{}")).toBe("Add charge.");
    expect(calls[0]!.body.payload_schema).toEqual(schema);
  });
});
