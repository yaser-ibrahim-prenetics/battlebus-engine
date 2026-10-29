# OOS parking and targeted drain

This document defines PR 4 of the Spock Store replacement sequence. It replaces long-lived,
per-order inventory polling with durable per-line dependencies and bounded targeted drains.

## Delivery contract

- GPS and D365 inventory failures are represented as typed dependencies. A dependency identifies
  the provider, canonical warehouse, provider SKU, original Shopify order line, required quantity,
  Shopify order and canonical store. Runtime code must not recover these identifiers by parsing an
  error message.
- Every original Shopify order line remains independently recoverable, including duplicate SKUs
  and lines combined into one provider request.
- Parking is one PostgreSQL transaction: dependency rows, the parked order state, safe failure
  evidence and a durable outbox notification either all commit or all roll back.
- Existing Battle Hub backorder events and manual retry controls remain supported. The targeted
  drain emits the same canonical `backorder/retry` event only after it has reserved enough stock for
  every unresolved dependency on the order.

## Durable states

Dependencies use these states:

- `parked`: eligible after `next_attempt_at`
- `leased`: temporarily owned by an exact drain lease
- `retrying`: replay was durably published
- `resolved`: the later order replay succeeded
- `manual_review`: expired, non-inventory failure, or exhausted recovery

Exact lease tokens prevent a stale worker from acknowledging another worker's claim. Dependency
leases are transaction-local during reservation; an interrupted transaction rolls them back to
`parked`. Expired drain-request leases are requeued with a fresh durable dispatch identity, while
expired dependencies move to `manual_review` and are never silently deleted.

An exact replay attempt also records a stable operation key and takes a renewable PostgreSQL
provider-mutation lease around every external write. Expiry, manual rearm, provider rollover and
outcome transitions use the same order-scoped lock and cannot invalidate an attempt while one of
its provider calls is in flight. Operation labels and canonical requests are stored only as SHA-256
fingerprints. Accepted results use shared typed projections (provider IDs, normalized status flags or
counts), never raw requests, credentials or customer payloads, and are capped at 4 KiB.
Provider-confirmed inventory rejections store only structured dependency evidence, enforce bounded
UTF-8 identifiers, support the maximum 500-line order within a 1 MiB cap, and replay without calling
the provider again; a rejected operation may be tried by a later replay token. Request mismatches and uncertain operations remain
hard-blocked, and an expired pending operation is promoted to uncertain instead of being executed
again. Independent line writes for the same attempt may hold concurrent leases; the same operation
or a different attempt cannot.

## Drain entry points

The same validated request model supports:

- inventory observations keyed by provider, warehouse and SKU;
- authenticated manual requests by key or order;
- scheduled reconciliation sweeps;
- date, order and SKU filters; and
- evidence-only dry runs.

For one live lane and canonical inventory key, the database stores at most one active request and one
coalesced successor. A newer observation refreshes the successor rather than creating unbounded
runs. Dry-run previews use a separate in-memory lane identity and are never inserted into the drain
request or outbox tables. Their immutable command receipt is retained for authorization, rate-limit
and idempotency evidence.

## FIFO and quantity allocation

Live drains load a bounded oldest-first candidate set, acquire transaction-level advisory locks for
every canonical provider/warehouse/SKU key, and then revalidate dependency status, cooldown, expiry
and version under order locks. Provider availability is read while those inventory locks are held,
and outstanding `retrying` quantities are reserved before allocation. An order with multiple blocked
lines is replayed only when all of them can be satisfied, including when independent drain lanes
compete for the same provider quantity.

Dry runs execute the same selection algorithm but never mutate dependencies, drain requests, orders
or outbox rows. Only the restricted command-audit receipt and aggregate preview result are written.

## Rollout

`OOS_TARGETED_DRAIN_ENABLED` defaults to `false`.

| Variable                            | Default | Purpose                                      |
| ----------------------------------- | ------- | -------------------------------------------- |
| `OOS_TARGETED_DRAIN_ENABLED`        | `false` | Activate typed parking and targeted drains   |
| `OOS_DRAIN_CLAIM_BATCH_SIZE`        | `100`   | Maximum orders examined by one bounded drain |
| `OOS_DRAIN_LEASE_SECONDS`           | `300`   | Exact request/outbox lease duration          |
| `OOS_DEPENDENCY_RETENTION_DAYS`     | `30`    | Time before unresolved work needs review     |
| `OOS_DEPENDENCY_MAX_ATTEMPTS`       | `10`    | Recovery attempts before manual review       |
| `OOS_DEPENDENCY_COOLDOWN_SECONDS`   | `3600`  | Delay after another inventory rejection      |
| `OOS_DRAIN_SWEEP_INTERVAL_MINUTES`  | `30`    | Reconciliation sweep cadence                 |
| `OOS_OUTBOX_DRAIN_INTERVAL_MINUTES` | `5`     | Durable event publisher cadence              |

1. Apply migrations 49 through 51.
2. Deploy with the flag disabled and verify migration assertions, queue health and Battle Hub access.
3. Enable typed parking for a controlled store/provider cohort.
4. Run dry-run drains and compare FIFO decisions with operator expectations.
5. Enable live targeted drains, then retire redundant per-order polling only after the evidence
   window is complete.

The `POST /api/operations/oos-drain` endpoint accepts only manual mode and authenticates exclusively
with the dedicated `BATTLE_BUS_OPERATIONS_API_KEY`; the general event-publishing key is rejected.
The server records the operations service principal rather than trusting caller-supplied actor
headers. A strict body requires a UUID `requestId` and a 10–1000 character `reason`, and immutable
command receipts reject conflicting UUID reuse while returning the original job for exact retries.
Set `dryRun: true` for aggregate selection evidence without dependency, drain-request, order or
retry-outbox mutation. Queue depth, oldest due age, retries, manual-review work, expired leases and
exhausted outbox entries are returned by the authenticated operations health view.

## Acceptance criteria

- Inventory for one warehouse/provider key never wakes work for another key.
- Concurrent drainers claim disjoint rows and cannot allocate the same observed quantity.
- An order with two blocked SKUs wakes only when both are satisfiable.
- Available inventory is allocated oldest-first without overselling.
- Repeated observations create at most one active drain and one successor per lane/key.
- Dry-run returns aggregate evidence with only its immutable command audit/result receipt mutated.
- A bounded batch can process a queue of at least 10,000 rows without loading the whole queue.
- Continued inventory failures apply cooldown and increment attempts; non-inventory failures and
  expired entries become visible manual-review work.
