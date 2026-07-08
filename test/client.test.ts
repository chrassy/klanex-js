import { describe, expect, it } from "vitest";

import { Klanex, KlanexError, KlanexSchemaError } from "../src/index.js";

type Call = { url: string; init: RequestInit };

function stubFetch(
  responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>,
) {
  const calls: Call[] = [];
  let i = 0;
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (!next) throw new Error("stubFetch: no response configured");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json", ...next.headers },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

function client(stub: { fetch: typeof globalThis.fetch }) {
  return new Klanex({ apiKey: "klx_test", baseUrl: "https://ingest.example.com/", fetch: stub.fetch });
}

describe("execute", () => {
  it("maps camelCase to the wire format and returns the execution id", async () => {
    const stub = stubFetch([
      { status: 202, body: { execution_id: "exe_1", status: "QUEUED" } },
    ]);
    const result = await client(stub).execute({
      target: {
        method: "POST",
        url: "https://api.example.com/refunds",
        headers: { Authorization: "Bearer sk" },
        timeoutMs: 10000,
      },
      payload: { charge_id: "ch_1", amount: 100 },
      payloadSchema: { type: "object" },
      callbackUrl: "https://me.example.com/hook",
      maxAttempts: 5,
      idempotencyKey: "refund-ch_1",
    });

    expect(result).toEqual({ executionId: "exe_1", status: "QUEUED", idempotentReplay: false });
    const call = stub.calls[0]!;
    expect(call.url).toBe("https://ingest.example.com/v1/executions");
    expect((call.init.headers as Record<string, string>)["X-API-Key"]).toBe("klx_test");
    const sent = JSON.parse(String(call.init.body));
    expect(sent.target.timeout_ms).toBe(10000);
    expect(sent.payload_schema).toEqual({ type: "object" });
    expect(sent.callback_url).toBe("https://me.example.com/hook");
    expect(sent.max_attempts).toBe(5);
    expect(sent.idempotency_key).toBe("refund-ch_1");
  });

  it("flags idempotent replays", async () => {
    const stub = stubFetch([
      {
        status: 200,
        body: { execution_id: "exe_1", status: "SUCCEEDED" },
        headers: { "X-Klanex-Idempotent-Replay": "true" },
      },
    ]);
    const result = await client(stub).execute({ target: { url: "https://x.example.com" } });
    expect(result.idempotentReplay).toBe(true);
  });

  it("throws KlanexSchemaError with the llm hint on 422", async () => {
    const stub = stubFetch([
      {
        status: 422,
        body: {
          error: {
            code: "SCHEMA_INVALID",
            message: "payload does not match payload_schema",
            problems: ['at "/": missing properties: \'charge_id\''],
            llm_hint: "Fix the following and resubmit:\n- missing charge_id",
          },
        },
      },
    ]);
    const err = await client(stub)
      .execute({ target: { url: "https://x.example.com" }, payload: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KlanexSchemaError);
    const schemaErr = err as KlanexSchemaError;
    expect(schemaErr.llmHint).toContain("missing charge_id");
    expect(schemaErr.problems).toHaveLength(1);
  });

  it("throws KlanexError with status and code on other failures", async () => {
    const stub = stubFetch([
      { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "invalid API key" } } },
    ]);
    const err = await client(stub)
      .execute({ target: { url: "https://x.example.com" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KlanexError);
    expect((err as KlanexError).status).toBe(401);
    expect((err as KlanexError).code).toBe("UNAUTHENTICATED");
  });
});

describe("get", () => {
  it("maps the wire execution to camelCase", async () => {
    const stub = stubFetch([
      {
        status: 200,
        body: {
          execution_id: "exe_1",
          status: "SUCCEEDED",
          attempts: 2,
          max_attempts: 5,
          target: {
            method: "POST",
            url: "https://api.example.com/x",
            headers: { Authorization: "REDACTED" },
          },
          result: { status_code: 200, body: '{"ok":true}' },
          replay_of: "exe_0",
          created_at: "2026-07-03T12:00:00Z",
          updated_at: "2026-07-03T12:00:05Z",
        },
      },
    ]);
    const execution = await client(stub).get("exe_1");
    expect(execution.maxAttempts).toBe(5);
    expect(execution.result?.statusCode).toBe(200);
    expect(execution.replayOf).toBe("exe_0");
    expect(execution.target.headers?.Authorization).toBe("REDACTED");
  });
});

describe("replay", () => {
  it("returns the clone with its origin link", async () => {
    const stub = stubFetch([
      { status: 202, body: { execution_id: "exe_2", status: "QUEUED", replay_of: "exe_1" } },
    ]);
    const result = await client(stub).replay("exe_1");
    expect(result).toEqual({ executionId: "exe_2", status: "QUEUED", replayOf: "exe_1" });
    expect(stub.calls[0]!.url).toBe("https://ingest.example.com/v1/executions/exe_1/replay");
  });
});

describe("waitForResult", () => {
  it("polls until terminal", async () => {
    const pending = {
      execution_id: "exe_1", status: "RETRYING", attempts: 1, max_attempts: 5,
      target: { url: "https://x.example.com" },
      created_at: "", updated_at: "",
    };
    const stub = stubFetch([
      { status: 200, body: pending },
      { status: 200, body: { ...pending, status: "SUCCEEDED", attempts: 2 } },
    ]);
    const execution = await client(stub).waitForResult("exe_1", { pollIntervalMs: 1 });
    expect(execution.status).toBe("SUCCEEDED");
    expect(stub.calls).toHaveLength(2);
  });

  it("throws on timeout", async () => {
    const pending = {
      execution_id: "exe_1", status: "QUEUED", attempts: 0, max_attempts: 5,
      target: { url: "https://x.example.com" },
      created_at: "", updated_at: "",
    };
    const stub = stubFetch([{ status: 200, body: pending }]);
    const err = await client(stub)
      .waitForResult("exe_1", { pollIntervalMs: 5, timeoutMs: 1 })
      .catch((e: unknown) => e);
    expect((err as KlanexError).code).toBe("WAIT_TIMEOUT");
  });
});

describe("rotateApiKey", () => {
  it("returns the new key and switches the client to it", async () => {
    const stub = stubFetch([
      { status: 200, body: { tenant_id: "ten_1", api_key: "klx_new" } },
      { status: 202, body: { execution_id: "exe_1", status: "QUEUED" } },
    ]);
    const c = client(stub);
    const out = await c.rotateApiKey();
    expect(out).toEqual({ tenantId: "ten_1", apiKey: "klx_new" });
    expect(stub.calls[0]!.url).toBe("https://ingest.example.com/v1/api-key/rotate");
    expect(stub.calls[0]!.init.method).toBe("POST");

    // The next call must use the rotated key, not the original.
    await c.execute({ target: { url: "https://x.example.com" } });
    expect((stub.calls[1]!.init.headers as Record<string, string>)["X-API-Key"]).toBe("klx_new");
  });
});

describe("rotateWebhookSecret", () => {
  it("returns the new secret", async () => {
    const stub = stubFetch([{ status: 200, body: { tenant_id: "ten_1", webhook_secret: "whsec_new" } }]);
    const out = await client(stub).rotateWebhookSecret();
    expect(out).toEqual({ tenantId: "ten_1", webhookSecret: "whsec_new" });
    expect(stub.calls[0]!.url).toBe("https://ingest.example.com/v1/webhook-secret/rotate");
    expect(stub.calls[0]!.init.method).toBe("POST");
  });
});
