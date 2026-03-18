# Battle Bus AI Engineering Guideline

This file defines the working standard for any AI agent modifying this repository. Follow it as a contract, not as optional advice.

---

## Contents

1. [Mission and System Shape](#1-mission-and-system-shape)
2. [Non-Negotiable Engineering Rules](#2-non-negotiable-engineering-rules)
3. [Project Conventions by Layer](#3-project-conventions-by-layer)
4. [TypeScript and Code Style](#4-typescript-and-code-style)
5. [Logging and Observability](#5-logging-and-observability)
6. [Security and Configuration](#6-security-and-configuration)
7. [Change Placement Rules](#7-change-placement-rules)
8. [Verification Standard](#8-verification-standard)
9. [Documentation Maintenance](#9-documentation-maintenance)
10. [Working Agreement for AI Agents](#10-working-agreement-for-ai-agents)
11. [Project-Specific Risks to Watch](#11-project-specific-risks-to-watch)
12. [Git and Dependency Conventions](#12-git-and-dependency-conventions)
13. [Minimum Bar for New Code](#13-minimum-bar-for-new-code)

---

## 1. Mission and System Shape

Battle Bus is a Next.js + TypeScript event-driven integration service. It receives inbound webhooks, converts them into Inngest events, and processes durable workflows that synchronize Shopify, Dynamics 365, GPS, Extensiv, Stord, Slack, and Battle Hub.

The repository is organized around these responsibilities:

- `src/app/`: App Router pages and HTTP endpoints.
- `src/app/api/webhooks/`: thin inbound adapters from third-party systems.
- `src/app/api/`: internal operational APIs consumed by Battle Hub or dev tooling.
- `src/inngest/events.ts`: event contracts between transport layer and workflow layer.
- `src/inngest/functions/`: durable workflows, retries, throttling, idempotency, fan-out.
- `src/lib/clients/`: external API clients and signature/auth helpers.
- `src/lib/transformers/`: data mapping between external systems.
- `src/lib/services/`: domain services with orchestration or cached lookup logic.
- `src/lib/helpers/`: small pure business helpers.
- `src/lib/types/`: shared type definitions for external payloads and internal shapes.
- `src/lib/mappings/`: static JSON config data.
- `docs/`: operational and architectural documentation.
- `scripts/`: manual probes, local diagnostics, and one-off test runners.

**File naming conventions:**

| Layer | Pattern | Example |
|---|---|---|
| Webhook route | `src/app/api/webhooks/<system>/route.ts` | `webhooks/shopify/route.ts` |
| Inngest function | `src/inngest/functions/<verb>-<noun>.ts` | `process-shopify-order.ts` |
| Client | `src/lib/clients/<system>.ts` | `dynamics.ts` |
| Transformer | `src/lib/transformers/<domain>.ts` | `order.ts` |
| Type definitions | `src/lib/types/<system>.ts` | `dynamics.ts` |

---

## 2. Non-Negotiable Engineering Rules

- Keep HTTP routes thin. Validate, authenticate, normalize, emit an event, and return quickly.
- Put long-running, retryable, or multi-step work in `src/inngest/functions/`, not inside route handlers.
- Keep external system calls inside `src/lib/clients/`. If you believe an exception is warranted, stop and raise it explicitly rather than making the call inline.
- Keep data conversion in `src/lib/transformers/`; do not bury mapping logic inside route handlers or clients.
- Prefer pure functions in `helpers/` and `transformers/`. Side effects belong in clients, services, routes, or Inngest steps.
- Update `src/inngest/events.ts` first when changing event payload shape. Event definitions are the contract.
- Preserve idempotency, retry safety, rate limits, and concurrency controls whenever touching Inngest functions.
- Do not introduce hidden global state. The only permitted exceptions are the existing token and config cache patterns already present in `src/lib/clients/`; do not add new ones.
- Do not add new secrets, API keys, tokens, or webhook secrets to source control.
- Do not silently swallow integration failures. Either handle them explicitly with business intent or surface them clearly in logs/errors.

### Rule priority

When two rules tension each other, the higher-priority rule wins:

1. **Security** — no credentials leaked, signatures verified, auth enforced.
2. **Correctness** — idempotency preserved, retries safe, data not corrupted.
3. **Contracts** — event shapes, webhook behavior, and backward compatibility maintained.
4. **Architecture** — correct layer placement, responsibilities separated.
5. **Style** — naming, formatting, comments.

### Scope vs contracts

"Prefer minimal changes" (Section 10) applies within a single layer. It does not override the requirement to update all layers when a contract changes. If a contract change is necessary, updating every touched layer in one pass is the minimal correct change.

---

## 3. Project Conventions by Layer

### 3.1 API Routes

Routes in `src/app/api/**/route.ts` should:

- Use `NextRequest` and `NextResponse`.
- Fail fast on malformed input or invalid signatures.
- Log with a stable domain prefix (see Section 5).
- Return structured JSON with a useful `message` field and appropriate HTTP status.
- Avoid complex branching if that logic belongs in a service or workflow.

For webhook routes specifically:

- Read the raw body via `request.text()` **before** JSON parsing when signature verification is required.
- Generate a unique request identifier and include it in every log line for that request.
- Emit named Inngest events with an event-level `id` field for idempotency rather than invoking downstream business logic directly.
- Return `200` or `202` quickly; downstream processing is always asynchronous.
- Do not return raw upstream error bodies to the caller.

**Correct pattern:**

```typescript
export async function POST(req: NextRequest) {
  // ✅ raw body first — required before JSON.parse for signature verification
  const body = await req.text();
  const signature = req.headers.get("x-shopify-hmac-sha256") ?? "";

  if (!verifyShopifySignature(body, signature)) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const requestId = `webhook-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const payload = JSON.parse(body) as ShopifyOrderPayload;
  console.log(`[Webhook] [${requestId}] Received shopify/order.created orderId=${payload.id}`);

  await inngest.send({
    id: `shopify-order-created-${payload.id}`, // ✅ event-level idempotency key
    name: "shopify/order.created",
    data: { ...payload, requestId },
  });

  return NextResponse.json({ received: true });
}
```

**Wrong — do not do this:**

```typescript
export async function POST(req: NextRequest) {
  const payload = await req.json(); // ❌ can no longer verify signature on raw body

  // ❌ business logic belongs in an Inngest function, not a route handler
  const order = await dynamicsClient.createSalesOrder(payload);
  await gpsClient.submitOrder(order);

  return NextResponse.json({ ok: true });
}
```

### 3.2 Inngest Functions

Functions in `src/inngest/functions/` are the core workflow layer. They should:

- Declare clear `id`, `name`, and event trigger configuration.
- Set `idempotency` whenever duplicate delivery is plausible. Prefer `"event.data.<stableBusinessKey>"` over `"event.id"` when a domain identifier exists.
- Use `retries`, `throttle`, `concurrency`, and `rateLimit` deliberately, not by default.
- Use `step.run`, `step.sleep`, `step.waitForEvent`, and publish helpers to create durable checkpoints.
- Give every step a meaningful name so Inngest traces are readable.
- Treat external writes as retry-sensitive; design them to be idempotent.
- Throw `NonRetriableError` (from the `inngest` package) for permanent failures where retrying is harmful: known invalid data, auth that cannot self-correct at runtime, or explicitly terminal business conditions. Always include a message that explains why the failure is permanent.

**Correct pattern:**

```typescript
import { NonRetriableError } from "inngest";

export const processShopifyOrder = inngest.createFunction(
  {
    id: "process-shopify-order",
    name: "Process Shopify Order",
    idempotency: "event.data.shopifyOrderId", // ✅ stable business key
    retries: 3,
    throttle: { limit: 10, period: "1s" },
  },
  { event: "shopify/order.created" },
  async ({ event, step }) => {
    const skuMap = await step.run("resolve-sku-mapping", async () => {
      const mapping = SKU_MAPPINGS[event.data.sku];
      if (!mapping) {
        // ✅ permanent failure — retrying cannot fix a missing mapping
        throw new NonRetriableError(
          `No SKU mapping for "${event.data.sku}". Add it to src/lib/mappings/dynamics-sku.json.`
        );
      }
      return mapping;
    });

    await step.run("create-dynamics-order", async () => {
      // ✅ transient failures (network, 5xx) are retried automatically by Inngest
      return dynamicsClient.createSalesOrder(
        transformShopifyOrderToDynamics(event.data, skuMap)
      );
    });
  }
);
```

When editing an existing function:

- Do not weaken existing throughput controls without a reason grounded in system behavior.
- Do not move network calls outside step boundaries; that reduces durability and traceability.
- Preserve the semantics of reruns, backorder handling, and event idempotency keys.

### 3.3 Clients

Files in `src/lib/clients/` should:

- Encapsulate one external system.
- Build URLs, headers, auth, retries, and response parsing in one place.
- Throw precise errors with upstream HTTP status code and message context.
- Avoid embedding business workflow decisions that belong in services or functions.
- Keep request/response types explicit.

When adding a client method:

- Reuse the existing config object and any token/auth helpers already present in that client.
- Reuse logging and cache patterns already present in that client.
- Keep the method small enough to be testable or script-verifiable.

**Correct pattern:**

```typescript
// ✅ reuses existing auth helper; throws precise error with status and body
async createSalesOrder(payload: D365SalesOrderRequest): Promise<D365SalesOrderResponse> {
  const token = await getToken(this.config); // ✅ reuse existing token helper
  const res = await fetch(`${this.config.baseUrl}/data/SalesOrderHeadersV3`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[Dynamics] createSalesOrder failed ${res.status}: ${text}`);
  }
  return res.json() as Promise<D365SalesOrderResponse>;
}
```

**Wrong — do not do this:**

```typescript
async createSalesOrder(payload: D365SalesOrderRequest) {
  const res = await fetch(URL, { ... });
  if (!res.ok) return null; // ❌ swallows the error; caller cannot distinguish failure from empty

  const order = await res.json();
  if (order.status === "pending") {
    await this.pollUntilComplete(order.id); // ❌ workflow logic belongs in an Inngest step
  }
  return order;
}
```

### 3.4 Services, Helpers, Transformers

- `services/` may coordinate multiple data sources or caching rules and may have side effects.
- `helpers/` must stay pure and focused — no network calls, no module-level state.
- `transformers/` must transform only — no network access, no side effects.
- If a function becomes hard to name because it does several things, split it.

**Correct transformer — pure, no side effects:**

```typescript
// ✅ pure function: same input always produces same output, no I/O
export function transformShopifyOrderToDynamics(
  order: ShopifyOrderPayload,
  skuMap: SkuMapping
): D365SalesOrderRequest {
  return {
    dataAreaId: resolveDataArea(order.currency),
    salesOrderLines: order.line_items.map((item) => ({
      itemNumber: skuMap[item.sku],
      salesQty: item.quantity,
    })),
  };
}
```

**Wrong — side effect inside a transformer:**

```typescript
// ❌ network call inside a transformer breaks purity and makes it non-retryable-safe
export async function transformShopifyOrderToDynamics(order: ShopifyOrderPayload) {
  const skuMap = await dynamicsClient.getSkuMappings(); // ❌ belongs in a step or service
  return { ... };
}
```

### 3.5 Error Handling

Distinguish between **transient** and **permanent** failures before deciding how to handle an error.

- **Transient** (network timeouts, rate limits, 5xx responses): do not catch inside a step. Let Inngest retry according to the function's `retries` config.
- **Permanent** (invalid payload, missing SKU mapping, 4xx that cannot self-correct): throw `NonRetriableError` to stop retries immediately.
- In route handlers: catch errors at the boundary, log with context, and return structured JSON. Never propagate raw upstream error bodies or stack traces to callers.
- Partial failures in multi-step workflows must be logged with enough context (order ID, step name, upstream status) to diagnose and replay the affected step.
- Do not use empty `catch` blocks or swallow errors with no log or rethrow.

---

## 4. TypeScript and Code Style

- Respect `strict: true`. Do not use `any` to silence type errors. When facing a genuinely untyped upstream boundary (e.g. a raw webhook body), use `unknown` and narrow it explicitly at the edge.
- Prefer explicit domain types from `src/lib/types` or `src/inngest/events.ts`.
- If an upstream payload is partially unknown, narrow it at the edge and keep the rest of the code typed.
- Use the `@/` import alias for all imports rooted under `src/`.
- Use `import type` for type-only imports.
- Match existing naming conventions:
  - `camelCase` for variables and functions.
  - `PascalCase` for types, interfaces, and classes.
  - `SCREAMING_SNAKE_CASE` for exported constants.
- Keep comments high-signal. Explain intent, invariants, or failure modes — not obvious syntax.
- Preserve the repo's existing section-divider comment style when editing files that already use it.

---

## 5. Logging and Observability

This system is integration-heavy. Logs are part of the product.

**Established log prefixes — use these; do not invent new ones without justification:**

| Prefix | Context |
|---|---|
| `[Webhook]` | Inbound webhook processing |
| `[Unified]` | Unified order or sync flow |
| `[InventorySync]` | Inventory synchronization |
| `[Backorder]` | Backorder retry or resolution |
| `[LocationRouting]` | Warehouse and routing decisions |

For a new integration flow, choose a stable single-word bracket prefix and use it consistently across every log line in that flow.

**Rules:**

- Include stable identifiers on every meaningful log line: order ID, order name, webhook ID, Inngest run ID, warehouse, `dataAreaId`.
- When a request or run ID is in scope, format as: `` `[Prefix] [${requestId}] <message> <key>=<value>` ``.
- Never log secrets, tokens, raw credentials, or full sensitive payloads.
- Prefer concise structured context over noisy narrative logging.
- Log at entry, on meaningful branch decisions, and at failure. Do not log every loop iteration.

**Correct log lines:**

```typescript
// ✅ prefix, request ID, stable identifier, structured key=value context
console.log(`[Webhook] [${requestId}] order.created orderId=${payload.id} shop=${payload.shop}`);
console.error(`[InventorySync] [${runId}] sync failed orderId=${orderId} status=500 upstream="${text}"`);
console.log(`[LocationRouting] resolved warehouse=${warehouse} dataAreaId=${dataAreaId} orderId=${orderId}`);
```

**Wrong — do not do this:**

```typescript
console.log("Processing order..."); // ❌ no prefix, no identifier, not greppable
console.error("Something went wrong"); // ❌ zero diagnostic value
console.log(`Token: ${token}`); // ❌ never log credentials
```

---

## 6. Security and Configuration

Current code includes legacy env fallbacks in `src/lib/config.ts`. Treat that as technical debt, not a pattern to expand.

- Do not add new hardcoded credentials, tokens, secrets, or production endpoints.
- Prefer environment variables with validation over permissive inline defaults.
- If you touch configuration behavior, update `validateConfig()` or equivalent safeguards.
- Maintain signature verification and auth checks on all inbound endpoints.
- Be careful with debug endpoints; do not expose raw internals or credentials.

---

## 7. Change Placement Rules

Use this decision table before editing:

| What you need | Where to change |
|---|---|
| Receive a third-party callback | Add or update a webhook route |
| New async business workflow | Add or update an Inngest function |
| Call an external API | Add or update a client |
| Reshape data between systems | Add or update a transformer |
| Warehouse, routing, or sync coordination | Add or update a service |
| One-off local diagnosis or manual probe | Add or update a script in `scripts/` |
| Architecture or runbook guidance | Update `docs/` |

If a change spans several layers, keep responsibilities separated instead of creating a god file.

---

## 8. Verification Standard

Before considering work complete, perform the cheapest meaningful verification available.

**This repository has no automated test suite.** Verification relies on static analysis, build integrity, and targeted scripts.

For code changes:

- **Always** run `npm run lint` when the change affects TypeScript, routes, components, or shared logic.
- Run `npm run build` when the change touches app code, route files, or shared configuration.
- Run a targeted script from `scripts/` when one already covers the affected integration flow (e.g. `npm run test:api`, `npm run test:gps-product`).
- If you cannot verify due to missing credentials, external dependencies, or environment limits, state that explicitly and describe what a human should verify manually.

For documentation-only changes:

- Ensure the document reflects actual repository structure and command names.
- Do not invent tests or scripts that do not exist.

---

## 9. Documentation Maintenance

This repository relies on `docs/` as an operational knowledge base. Keep it accurate.

- Update docs when changing event names, API routes, webhook contracts, warehouse routing, inventory sync behavior, or runbook steps.
- Keep architecture docs aligned with actual code paths.
- Prefer editing an existing doc over creating duplicates unless the topic is genuinely new.
- Preserve concise, operationally useful writing. Avoid marketing language in engineering docs.

---

## 10. Working Agreement for AI Agents

### Before starting

1. Read every file you intend to modify. Do not patch blindly.
2. Search for existing utilities, helpers, or client methods before creating new ones.
3. Identify which layers the change touches and confirm placement is correct per Section 7.
4. If the change modifies an event contract or webhook payload, plan the full-layer update before writing any code (see Contract changes below).

### Contract changes

A contract change is any modification to:
- A field name, type, or presence in `src/inngest/events.ts`.
- A webhook route's accepted payload shape.
- A client's public method signature or response type.

When a contract change is required, update all six layers in one pass:

```
1. src/inngest/events.ts          — update the event type definition first
2. src/app/api/webhooks/*/route.ts — update the inbound adapter if payload changed
3. src/inngest/functions/*.ts      — update the function consuming the event
4. src/lib/clients/*.ts            — update the client method if its signature changed
5. src/lib/transformers/*.ts       — update the transformer if field names changed
6. docs/                           — update any doc that references the changed contract
```

Do not leave any layer partially updated. A type error in one layer means the full pass is incomplete.

### Blocker protocol

If you encounter any of the following, **stop writing code** and state the blocker explicitly:

- A required config value or env variable not present in `src/lib/config.ts`. Before concluding it is absent, read `src/lib/config.ts` in full and search existing clients for the key pattern.
- A task that requires a new external system with no existing client to follow as a pattern.
- An ambiguous requirement with two or more valid interpretations that produce meaningfully different code.
- The task requires modifying more than 3 files you did not anticipate when you started reading.
- The correct fix requires first correcting existing code that violates this guideline.

**State:** what is unknown, what assumption you would make if you proceeded, and what a human needs to clarify.

**If clarification is not available:** proceed with the safest interpretation, add a `// TODO(assumption): <what you assumed and why>` comment at each affected call site, complete every part of the task that is unambiguous, and list all unresolved items explicitly at the end of your response.

### While working

- "Prefer minimal changes" applies within a single layer. It does not override the requirement to update all layers when a contract changes.
- Preserve backward compatibility for external events and webhook behavior unless the task explicitly changes contracts.
- Do not clean up unrelated files as part of the task.
- Assume the git worktree may be dirty; never revert unrelated work.
- If you discover an existing bug unrelated to the task, note it explicitly rather than fixing it silently.

### Before finishing

Verify each item mechanically, not by inspection:

- [ ] `npm run lint` passes with no new errors.
- [ ] `npm run build` succeeds if any app code was changed.
- [ ] Every file you created or modified is in the correct layer per Section 7 and follows the naming convention from Section 1.
- [ ] No secrets or hardcoded credentials were introduced. Scan changed files for raw tokens, passwords, or URLs containing credentials.
- [ ] Every `console.log` in changed files uses an established prefix from Section 5 and includes at least one stable identifier.
- [ ] Every Inngest function you modified still declares `idempotency`. If you added a `NonRetriableError`, its message explains why retrying is harmful.
- [ ] If a contract change was made (field added/removed/renamed in `events.ts`, webhook payload, or client signature), all six layers listed above are updated.

---

## 11. Project-Specific Risks to Watch

- **Duplicate webhook delivery and reruns** — always verify idempotency keys are set at both the Inngest event `id` level and the function `idempotency` config.
- **Partial failures across systems** — Shopify, D365, GPS, Extensiv, and Stord have different error semantics; handle each explicitly.
- **Inventory and fulfillment flows** — must remain idempotent; double-writes cause real operational damage.
- **Country-specific routing and `dataAreaId` selection** — wrong data area silently processes orders in the wrong region.
- **Cached configuration or token state** — may go stale; validate before trusting cached values in critical paths.
- **Local scripts and docs** — may lag behind the production code path; keep them updated when touching the flows they cover.

When in doubt, choose the safer behavior:

- validate early
- publish explicit events
- keep writes idempotent
- log traceable identifiers
- preserve durable checkpoints
- document contract changes

---

## 12. Git and Dependency Conventions

### Commit messages

Use the conventional commit format: `<type>: <description>` (lowercase, no trailing period).

| Type | When to use |
|---|---|
| `feat` | New functionality |
| `fix` | Bug fix |
| `refactor` | Code restructure with no behavior change |
| `docs` | Documentation only |
| `chore` | Tooling, config, or dependency changes |

Write descriptions in imperative form: `fix: dynamics error when sku unavailable`, not `fixed the Dynamics 365 error that happens when the SKU is not available`.

### Dependencies

- Do not add npm packages without justification. Prefer solving problems with existing dependencies first.
- When a new package is necessary, choose one with active maintenance, minimal transitive dependencies, and a compatible license.
- Do not introduce packages that bundle client-side code into server-only code paths.
- After adding a dependency, run `npm run build` to confirm the build remains clean.

---

## 13. Minimum Bar for New Code

New code is acceptable only if it meets **all** of the following:

- [ ] Correctly placed in the architecture (Section 7) with the correct file name (Section 1).
- [ ] Typed under `strict: true` — no `any`; untyped upstream boundaries use `unknown` and are narrowed explicitly at the edge.
- [ ] Observable in failure modes — error paths log with a prefix, a stable identifier, and enough context to diagnose and replay.
- [ ] Safe for retries and duplicate delivery.
- [ ] Free of new hardcoded secrets or production endpoints.
- [ ] Verified via lint and build (and targeted scripts where applicable).
- [ ] Documented when it changes system behavior visible outside this repository.

If a proposed change cannot meet that bar, reduce scope or redesign it before implementation.
