# klanex

Official TypeScript/Node SDK for [klanex](https://klanexai.com) — the tool
orchestration engine for AI agents. Fire a tool-use intent, get an
`execution_id` back in milliseconds, and let the engine own retries, backoff,
circuit breaking, credentials, and signed webhooks.

```bash
npm install klanex
```

Requires Node 18+. Zero runtime dependencies.

> Building in Python? See the [Python SDK](https://github.com/chrassy/klanex-python).

## Submit a tool call

```ts
import { Klanex, KlanexSchemaError } from "klanex";

const klanex = new Klanex({ apiKey: process.env.KLANEX_API_KEY! }); // https://api.klanexai.com

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

## Agent frameworks

Turn any API call into a native tool for the
[Vercel AI SDK](https://ai-sdk.dev) or the
[OpenAI Agents SDK](https://openai.github.io/openai-agents-js/). The model's
tool input becomes the request payload; klanex owns the call's reliability
(schema gate, retries with backoff, circuit breakers, approvals, credentials)
and the tool returns text the model can act on:

- **Success:** the target's response.
- **Rejected:** the `llm_hint`, which names the bad field when klanex can
  tell, so the model fixes one value and calls again.
- **Still running** after `waitTimeoutMs` (default 2 min), or **waiting for
  approval:** a note telling the model the action is in progress and not to
  call the tool again, so a slow API never turns into a duplicate charge.
- **Exactly once per tool call:** the framework's tool call ID becomes the
  idempotency key, so a resumed or retried agent step never runs the action
  twice. Opt out with `idempotency: false`.

The model never sees the target URL or credentials. Use a vault
`connectionId`, or `headers`, which are encrypted at rest.

### Vercel AI SDK (`ai` 5, 6, or 7)

```ts
import { generateText, stepCountIs } from "ai";
import { z } from "zod";
import { Klanex } from "klanex";
import { klanexTool } from "klanex/ai";

const klanex = new Klanex({ apiKey: process.env.KLANEX_API_KEY! });

const refund = klanexTool(klanex, {
  name: "refund",
  description: "Refund a Stripe charge",
  inputSchema: z.object({ charge: z.string(), amount: z.number().int() }),
  target: { url: "https://api.stripe.com/v1/refunds", connectionId: "con_..." },
});

const { text } = await generateText({
  model,
  tools: { refund },
  stopWhen: stepCountIs(5),
  prompt: "Refund charge ch_123 in full",
});
```

### OpenAI Agents SDK (`@openai/agents`)

```ts
import { Agent, run } from "@openai/agents";
import { z } from "zod";
import { Klanex } from "klanex";
import { klanexTool } from "klanex/openai-agents";

const klanex = new Klanex({ apiKey: process.env.KLANEX_API_KEY! });

const refund = klanexTool(klanex, {
  name: "create_refund",
  description: "Refund a Stripe charge",
  parameters: z.object({ charge: z.string(), amount: z.number().int() }),
  target: { url: "https://api.stripe.com/v1/refunds", connectionId: "con_..." },
  requiresApproval: true, // a human approves in Slack or the dashboard first
});

const agent = new Agent({ name: "Support", instructions: "...", tools: [refund] });
const result = await run(agent, "Refund charge ch_123 in full");
```

Both adapters also take a plain JSON Schema instead of Zod. Frameworks pass
JSON Schema input through unchecked, so klanex enforces it with its schema
gate, and a failing input comes back to the model as a correction hint. The
`klanex/ai` and `klanex/openai-agents` entry points do not use `node:crypto`,
so they run on edge runtimes too.

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
import { verifyWebhook, WEBHOOK_HEADERS, WebhookVerificationError } from "klanex";

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

## Rotate credentials

```ts
// Old key stops working immediately; this client switches to the new one.
const { apiKey } = await klanex.rotateApiKey();

// Callbacks after this are signed with the new secret — update your verifier.
const { webhookSecret } = await klanex.rotateWebhookSecret();
```

Each secret is returned only once. If other processes share the key, persist
the value from `rotateApiKey()`.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsup → dist/ (esm + cjs + d.ts)
```
