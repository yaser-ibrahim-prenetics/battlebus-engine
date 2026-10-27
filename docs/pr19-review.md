# PR 19 review and validation

Bugbot and Security Review independently reviewed commit `6dad3d6`. They reported ten actionable findings. The fixes are in commits `60a3415`, `6756176`, `a78b379`, and `e7c848c`; regression tests verify the corrected behavior. Locations below refer to the reviewed commit.

| Severity | Location (file:line) | Finding |
|---|---|---|
| P1 | `src/lib/services/order-segments/process.ts:94` | STORD routing overrides/fallback were bypassed. Fixed with the shared routing policy and routing regression tests. |
| P1 | `src/lib/services/order-segments/reporting.ts:29` | Mixed-company plans could refund against the first company's header. Such plans now stop before external mutations; cross-company refund allocation remains unsupported. |
| P1 | `src/inngest/functions/cron-gps-sync.ts:606` | The downstream per-order rate limit could discard the sixth shipment. Removed the lossy limit; throttling and concurrency remain. |
| P1 | `src/lib/services/order-segments/fulfillment.ts:39` | Gift-card issuance fulfillments could block physical shipments. Nonphysical receipts are excluded from physical allocation. |
| P1 | `src/inngest/functions/process-backorder.ts:102` | Manual recovery bypassed current eligibility checks. Fresh paid/cancellation/risk checks run before each recovery segment and GPS dispatch. |
| P2 | `src/inngest/functions/process-shopify-fulfillment.ts:227` | Early return skipped Hub and PayPal tracking. Segment results now continue through the shared completion path. |
| P2 | `src/lib/services/order-accounting/load.ts:38` | Failed gift-card attempts blocked successful card payments. Only successful gift-card capture/sale transactions require receipts. |
| P2 | `src/lib/services/order-accounting/load.ts:56` | Presentment-currency receipts could make fully gift-card-funded orders appear unpaid. The accounting read requests shop currency explicitly. |
| P2 | `src/lib/services/order-segments/fulfillment.ts:86` | A later callback's date could conflict with an accepted D365 operation. Allocations now persist the first posting date. |
| P2 | `src/lib/services/order-segments/fulfillment.ts:115` | Concurrent snapshots could overwrite completion with stale state. Publication is serialized and completion is monotonic. |

Cancellation fan-out was also hardened with independent action identities and checkpoints. A confirmed first cancellation is not repeated when a later segment times out.

Validation after fixes: 579 tests passed, six existing tests skipped; production build passed; lint passed with 368 warnings and no errors, within the repository's existing limit. All 24 paired migrations passed validation and PostgreSQL up/down/up tests. Production dependency audit found no vulnerabilities. Deployment regression tests and Shopify GraphQL schema validation passed.

The new PostgreSQL integration cases cover fresh order replay, second-shipment rejection, unknown Shopify outcomes, concurrent allocation, duplicate GPS/Shopify delivery, partial shipments, original-date recovery, nonphysical receipts, cancellation during recovery, mixed-company rejection, concurrent completion publication, and cancellation replay. Provider transports are stubbed; these tests do not prove live provider acceptance or execute production financial operations.

The corrected currency behavior follows [Shopify's transaction documentation](https://shopify.dev/docs/api/admin-rest/latest/resources/transaction). The rate-limit correction follows [Inngest's documented skip behavior](https://www.inngest.com/docs/durable-execution/flow-control/rate-limiting).
