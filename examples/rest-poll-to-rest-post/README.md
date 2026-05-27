# Example integration: REST poll → REST POST

The canonical demo integration. Polls a mock "System A" REST API every minute for new orders, transforms each order into a simpler shape, and POSTs each to "System B."

## What to paste into the UI

**Description:**

> Poll System A's REST API at `SYSTEM_A_URL/orders?since=<cursor>` every minute for new orders. Track the last seen `created_at` via the `CURSOR` secret (start from epoch on first run). For each new order, transform the payload to `{orderId: id, customerName: customer, totalAmount: amount}` and POST it to `SYSTEM_B_URL/orders`. Update `CURSOR` to the latest `created_at` after a successful batch. Use the global `fetch` for all HTTP.

**Trigger:** cron `*/1 * * * *` (every minute — keep it tight for the demo)

**Secrets to set after submit** (use the Secrets pane or seed via DB):

| Name | Value |
|---|---|
| `SYSTEM_A_URL` | `http://mock-system-a:5001` |
| `SYSTEM_B_URL` | `http://mock-system-b:5002` |
| `CURSOR` | `1970-01-01T00:00:00.000Z` (will be updated by the integration) |

## Expected flow

1. Submit the description → Temporal workflow starts → state `Generating`
2. Agent generates Python — sorry, TypeScript — with the contract `export async function run(secrets, triggerPayload)` returning `{ ok, output? }`
3. State → `Tested`. Sandbox runs the code against the mock services; UI shows stdout/stderr + the output payload
4. User clicks Approve → state `Approved` → `Building` → `Deployed`
5. Runner picks up the deployed integration. Cron fires every minute. Each fire calls into the sandbox with the integration's image
6. Inspect: `curl http://localhost:5002/received` shows the POSTs landed on mock System B

## Why this shape was chosen

- Smallest viable code that demonstrates both directions of an integration (read source, write target)
- Cron triggers are the most common real-world pattern (per the brief's first example)
- Two REST APIs is the easiest to mock locally (one each for source and target)
- Total generated code is ~30-40 lines — well within what the LLM produces reliably

## Reference output

The agent should produce something close to this (illustrative; the actual generation will vary):

```typescript
export async function run(
  secrets: Record<string, string>,
  triggerPayload?: unknown,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const cursor = secrets.CURSOR || "1970-01-01T00:00:00.000Z";
    const sourceUrl = `${secrets.SYSTEM_A_URL}/orders?since=${encodeURIComponent(cursor)}`;
    const resp = await fetch(sourceUrl);
    if (!resp.ok) {
      return { ok: false, error: `source returned ${resp.status}` };
    }
    const orders = await resp.json() as Array<{id: string; customer: string; amount: number; created_at: string}>;

    let lastSeen = cursor;
    let sent = 0;
    for (const order of orders) {
      const payload = {
        orderId: order.id,
        customerName: order.customer,
        totalAmount: order.amount,
      };
      const post = await fetch(`${secrets.SYSTEM_B_URL}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (post.ok) {
        sent += 1;
        if (order.created_at > lastSeen) lastSeen = order.created_at;
      }
    }
    return {
      ok: true,
      output: { processed: sent, new_cursor: lastSeen },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

The egress proxy will see two outbound calls per run: one GET to `mock-system-a:5001`, one or more POSTs to `mock-system-b:5002`. Both are allowlisted via the `declared_endpoints` Claude generates alongside the code.
