# Split orders and Shopify payment accounting

Battle Bus builds and stores a quantity-based plan before Shopify splitting or D365/GPS order creation. Each physical Shopify fulfillment order remains a separate segment. International threshold splitting uses the existing `FULFILLMENT_SPLIT_THRESHOLD_INTERNATIONAL` setting (default 250); domestic threshold splitting remains disabled unless configured. A single indivisible unit above the threshold remains one segment.

Each segment receives its own D365 header, lines, confirmation, prepayment and GPS order. Plans spanning multiple D365 legal entities are rejected before Shopify/provider writes: the existing refund path cannot yet allocate credits safely across companies. This is an explicit safety boundary, not a claim of cross-company refund support. D365 keeps the original Shopify reference on every header, as Spock does. GPS references use the original order name and then `-1`, `-2`, and so on. Shipping, tax, duties and nonphysical accounting lines belong to the first segment. Per-unit splits conserve line quantities and allocate discount cents without duplication.

Payment references come from successful non-gift-card Shopify capture/sale transactions, using the Shopify order-ID fallback only when the successful transaction has no payment ID. Applied gift-card comments include masked identifiers and successful captured amounts in shop currency; failed attempts do not block another successful payment. Purchased gift-card lines carry their issuance receipt identifier in `THK_DiscountType`. Issuance receipts are refreshed inside the retryable accounting step, so a delayed receipt can become available on retry. Paid orders with incomplete transaction/receipt data wait before financial writes.

## Storage and recovery

- `order_segment_plans` stores immutable plans and provider progress, scoped by Shopify domain and order ID. The runtime can update progress, but cannot rewrite plans.
- `fulfillment_actions` reserves Shopify split and D365 financial actions before external calls. The existing GPS ledger protects each segment's outbound request.
- `order_segment_fulfillments` reserves shipped quantities transactionally, including which shipment owns service lines. Concurrent events cannot claim the same remaining units. The first posting date is persisted and reused across GPS/Shopify callback retries. Completion publications are serialized per parent order.
- Battle Hub receives each segment's fulfillment-order ID, D365 order number, GPS order number, warehouse and progress in `orders.state.orderSegments`. The primary D365/GPS fields remain the first segment for compatibility.

Replay the original order or use manual backorder recovery to resume the stored plan. Manual recovery rechecks current cancellation, payment and risk eligibility before each segment and GPS dispatch. A successful operation reuses its recorded result. A timeout/crash with an unknown provider outcome remains blocked; confirm the result in Shopify/D365/GPS and reconcile the action ledger before replay. Do not delete ledger rows or create a new plan to bypass an uncertain action. Changed financial quantities or routing need explicit reconciliation rather than regrouping accepted orders.

GPS webhook and polling paths resolve the specific segment's Shopify fulfillment order. D365 postings use the persisted segment inventory lots, including proportional quantities for bundle components. The GPS sync-only path and a later real Shopify webhook share the same full-shipment allocation identity. Partial shipments reserve service lines once. A partial combined Shopify fulfillment spanning multiple segments of the same source line is rejected when the source quantities cannot be unambiguously assigned; operators must reconcile its fulfillment-order allocation rather than guess.

Cancellation fans out to all confirmed GPS segment IDs with individual durable actions and checkpoints. Missing or uncertain GPS IDs require recovery before cancellation can be declared complete. Hub and PayPal tracking updates continue through the shared fulfillment completion path. Fulfillment uses throttling/concurrency rather than a per-order rate limit that could discard later shipments. Existing aggregate D365 orders continue through the legacy path and are not retrospectively split. Direct reconciliation retains the original Shopify reference shared by all segments.

The existing dry-run, Dynamics/GPS enable flags, Shopify fulfillment-writeback control and Slack controls remain in force. This PR does not enable live writes or Slack delivery.

## Verification

Local PostgreSQL tests exercise complete replay, a rejected second shipment, an ambiguous Shopify split, concurrent shipment allocation, GPS/Shopify duplicate delivery, and two partial shipments. Pure transformation tests verify quantity, discount, freight and tax conservation, payment reference selection, gift-card receipts and GPS exclusion. Migrations are tested up/down/up, including runtime and browser-role access assertions.

New GraphQL operations are pinned to the existing supported accounting/reconciliation version, `2026-07`, and validated against Shopify's schema. They require the relevant order and merchant/third-party fulfillment-order scopes. See [Shopify fulfillmentOrderSplit](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/fulfillmentOrderSplit).

Reference: Spock Store `develop` at `2c263e8`, specifically sales-order creation, split fulfillment, gift-card applications and payment-reference handling. Tests use synthetic fixtures and stubbed provider transports; no production financial operations were executed.
