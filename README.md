# klanex

Official TypeScript/Node SDK for [klanex](https://github.com/chrassy/klanex) —
the tool orchestration engine for AI agents. Fire a tool-use intent, get an
`execution_id` back in milliseconds, and let the engine own retries, backoff,
circuit breaking, credentials, and signed webhooks.

```bash
npm install @klanex/sdk
```

Requires Node 18+. Zero runtime dependencies.

## Submit a tool call

```ts
import { Klanex, KlanexSchemaError } from "@klanex/sdk";

const klanex = new Klanex({
  apiKey: process.env.KLANEX_API_KEY!,
  baseUrl: "https://klanex-ingest-....run.app",
});

const { executionId } = await klanex.execute({
  target: {
    method: "POST",
    url: "https://api.stripe.com/v1/refunds",
    headers: { Authorization: `Bearer ${process.env.STRIPE_KEY}` }, // encrypted at rest
  },
  payload: agentGeneratedJson,
  payloadSchema: refundSchema,          // gate hallucinations before they queue
  callbackUrl: "https://you.example.com/hooks/klanex",
  idempotencyKey: `refund-${chargeId}`, // retries can never double-refund
});
```

## The self-correction loop

When the agent hallucinates a payload, `execute` rejects synchronously with a
hint written to be pasted straight back into the model's context:

```ts
try {
  await klanex.execute({ target, payload, payloadSchema });
} catch (err) {
  if (err instanceof KlanexSchemaError) {
    // e.g. "The JSON payload you generated does not match the required
    //       schema. Fix the following and resubmit: ..."
    messages.push({ role: "user", content: err.llmHint! });
    return retryWithLLM(messages);
  }
  throw err;
}
```

Failed executions carry the same shape: `execution.error.llmHint` explains a
`TARGET_REJECTED` (4xx) so the agent can fix its payload, while retryable
failures (`TARGET_RATE_LIMITED`, `TARGET_UNAVAILABLE`, ...) never reach you —
the engine absorbs them.

## Receive results via webhook

```ts
import { verifyWebhook, WEBHOOK_HEADERS, WebhookVerificationError } from "@klanex/sdk";

app.post("/hooks/klanex", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = verifyWebhook({
      secret: process.env.KLANEX_WEBHOOK_SECRET!,
      body: req.body, // RAW bytes — never re-serialize before verifying
      signature: req.header(WEBHOOK_HEADERS.signature)!,
      timestamp: req.header(WEBHOOK_HEADERS.timestamp)!,
    });
  } catch (err) {
    if (err instanceof WebhookVerificationError) return res.sendStatus(400);
    throw err;
  }
  // event.status is "SUCCEEDED" or "FAILED"; event.result.body holds the
  // target API's response.
  res.sendStatus(200);
});
```

Signature format: `sha256=` + hex HMAC-SHA256 of `"<timestamp>.<body>"` —
verified byte-for-byte compatible with the engine's Go implementation, with
replay protection via the timestamp (300s tolerance by default).

## Poll instead (scripts, tests)

```ts
const execution = await klanex.waitForResult(executionId, { timeoutMs: 60_000 });
if (execution.status === "FAILED") console.error(execution.error);
```

## Replay after an outage

```ts
const { executionId: cloneId } = await klanex.replay(failedExecutionId);
```

Re-runs the byte-exact original payload with the same sealed credentials —
no re-prompting the LLM that generated it.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsup → dist/ (esm + cjs + d.ts)
```
