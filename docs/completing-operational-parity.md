# Completing operational parity

This phase starts from main and preserves dry-run and provider-write switches.

## Acceptance criteria

- Split plans can span legal entities. Refund allocations are reserved before provider writes, conserve integer cents, and replay the original allocation. Fulfillment allocations conserve source quantities across partial deliveries.
- Sales-order, GPS, fulfillment, inventory and direct D365 checks persist structured attempts, including errors and discrepancies. A missing provider response is never a match.
- Direct D365 checks compare company routing, quantities and financial evidence. Automatic recovery requires conclusive provider evidence tied to the reserved action; age alone never authorizes a repeat write.
- Authenticated operational health reports dependency connectivity, inbox age, stale reconciliation attempts and uncertain action age. Restricted recovery operations validate their scope and retain an audit record.
- Battle Hub exposes history, health and recovery only through server-authorized endpoints.

## Release verification

Run unit and database migration tests, lint and builds. Review the final diff and fix findings before requesting review. Provider verification must record the actual environment and read-only probe outcome; configuration presence alone is insufficient. Production activation and deployment are separate from this PR.

## Allocation and recovery rules

- Segments execute independently; all settle before a failed segment is surfaced. Successful provider actions stay checkpointed and protected by the action ledger.
- Combined partial shipments allocate source-line quantities in stable segment order, restricted to the Shopify fulfillment's associated fulfillment orders. Outstanding reservations consume capacity, so retries/concurrent shipments cannot allocate the same units twice.
- Refund merchandise follows its reserved segment; tax, freight and order-level adjustments follow segment zero. Amount-only refunds use remaining original financial balances. New segments persist their original posted amount; older plans reconstruct the same transformation, including gift-card accounting, shipping discounts, duties and cumulative discount rounding. Quantity and money reservations are committed before writes. Each affected segment independently waits for a completed provider binding.
- Refund posting currently requires USD shop-money evidence, matching the existing D365 posting contract. Presentment-currency conversion requires receipt/transaction evidence; fallback FX rates are rejected. Missing evidence blocks posting rather than guessing.
- Automatic shipment resolution requires persisted recovery context, exact item/lot/quantity/date evidence, a unique packing slip and an invoiced sales order. A document can be claimed by only one attempt. Legacy actions without context, ambiguous documents and uninvoiced shipments remain unresolved. Recovery never blindly repeats an uncertain provider mutation.

## Operations and release procedure

Deploy Bus migrations 026–039 before its new runtime, then the companion Hub UI. The migrations are additive and keep runtime access scoped; audit identity/reason/parameters cannot be rewritten by the runtime role. Existing deployment write switches and dry-run configuration remain authoritative.

Direct reconciliation is enabled by default in code; an explicit `ENABLE_D365_RECONCILIATION=false` still disables it. Each run first verifies Shopify identity and D365 company-scoped header/schema access. Empty company evidence fails closed. Detailed comparisons cover quantities, net line totals, currency and expected company. Provider reads are checkpointed in batches of five orders; windows over 2,000 Shopify orders must be divided. Full evidence is persisted in PostgreSQL; retry exhaustion marks both histories failed.

In Hub, Battle Hub workspace Admins and Superadmins can open Reconciliation → Operational health, structured history and recovery. The server verifies authorization and derives the actor from the session; client-supplied actors are ignored. Available recovery actions:

1. Verify an uncertain shipment against provider evidence.
2. Replay an unpublished inbox entry with its original stable event IDs.
3. Resume an order through existing fresh-Shopify validation and provider-write guards.
4. Request a bounded reconciliation window.
5. Cancel a locally observed stale run only after Inngest confirms it is running.
6. Close stale reconciliation history only after Inngest confirms the workflow is terminal.

Every command requires a reason and stable request ID. `dispatched` means a downstream workflow was accepted, not that its business processing succeeded. `blocked`/`failed` requires investigation. For an unchanged retry, reuse the original request ID. History, inbox, uncertain actions and command lists return the most recent 50 rows; detailed provider failures are logged using safe categories and correlation IDs.

Deep operational checks are separate from the deployment liveness endpoint. They probe Cloud SQL, Shopify, enabled D365/GPS dependencies, Inngest and enabled Hub integration. Health reports inbox/uncertain-action age, stale reconciliation attempts and provider-verified stale workflows. Known future waits are excluded; unknown waits are shown as uncertain rather than automatically cancelled. Workflow observations start with this release; historical runs are not backfilled.

## Validation evidence and outstanding release gate

Local PostgreSQL 16 migration up/down/up checks passed through migration 039, including RLS, immutable audit fields and concurrency assertions. Final local Bus suite with all CI database suites enabled: 619 tests passed, 6 environment-dependent tests skipped. Hub: 16 access tests passed. Production builds and the Bus lint gate passed; Hub operations files pass ESLint. Repository-wide Bus `tsc --noEmit` still reports pre-existing test-fixture typing errors; application builds pass.

The standards and specification reviews found financial ownership, original-capacity, gift-card, partial-progress and retry-checkpoint defects; all were corrected with regression tests. No remaining actionable findings were reported in the final follow-ups.

Live provider environment verification is **pending**: the Google Cloud CLI session expired and browser sign-in was requested. No deployment or production provider writes were performed for this phase. Before marking the Bus PR ready, complete sign-in, inspect the deployed environment metadata, execute the authenticated read-only health probes, and record Shopify identity, D365 origin/company/schema results and GPS/Inngest/Hub probe outcomes. Do not interpret local mocks or configuration presence as production parity. Keep the PR in draft until this evidence is recorded.

CI follow-up corrected a test that assumed sequential D365 order-number assignment. It now verifies persisted segment/order/lot bindings under independent execution. The companion Hub page formatting was also corrected.
