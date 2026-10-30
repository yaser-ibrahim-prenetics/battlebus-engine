# Per-order workflow timeline

Migration 58 adds append-only order history and the read-only `battle_hub_workflow_timeline` view. A database trigger captures newly inserted canonical `flow_logs` rows in the same transaction. Both buffered and synchronous logging work without changing application writers. History remains after flow-log retention deletes source rows. Existing rows are not backfilled; events lost before the source log reaches PostgreSQL cannot be recovered by this feature.

Runtime can select and append history but cannot update, delete or truncate it, including through inherited service-role privileges. Hub can read the restricted view only. Provider error messages, error types, request payloads and arbitrary metadata are omitted. Structured order/run identifiers, workflow stages, statuses and durations remain available. No new Hub UI is claimed.

This is the remaining timeline slice of old PR 27. Current main already implements leased inbox delivery, retries, dead letters and audited replay; the retired event-outbox implementation is not reintroduced. Provider-specific payload schema validation remains separate work; this PR does not add an arbitrary transport-header version contract.

Deploy migration 58 before using the view. Rollback drops the new timeline and trigger, so archive history first if retention is required. The application continues using its unchanged flow-log contract.

Validation: migration assertions exercise capture, retention independence, runtime mutation denial and Hub read-only access.

The canonical `battle_bus_runtime` role is required for order-correlated flow-log writers. Legacy connections with only `service_role` must adopt the runtime role before rollout.
