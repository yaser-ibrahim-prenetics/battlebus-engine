# 002: Verified Cloud Run rollouts with a warm service instance

- Date: 2026-10-22
- Status: Accepted

## Context

The user requested near-zero deployment downtime and explicitly approved the ongoing cost of one warm instance per service. Production remains protected by existing authentication and dry-run/provider-write safeguards.

## Decision

Keep one **service-level** minimum instance, with no per-revision minimum. Deploy an explicitly named, zero-traffic candidate; make read-only HTTP checks against that candidate before promotion. Capture resolved serving revision percentages immediately before deployment. Promote only the tested revision and require three consecutive successful checks through the canonical service URL, including exact revision identity. Restore the captured traffic split on promotion or post-promotion failure.

Serialize main releases. Never target `LATEST` or use `latestReadyRevisionName` as the rollback destination. Keep application checks separate from local shell fault-injection tests; passing local tests does not prove live availability.

## Rationale

The current release continues serving while the replacement starts and its dependencies are verified. Service-level minimum instances reduce cold starts without keeping every historical tagged revision warm. A zero-traffic candidate gives a smaller, more predictable release boundary than a canary without a production metrics gate.

## Consequences

- One warm instance is a best-effort latency measure, not redundant high availability or a zero-downtime guarantee. It adds ongoing cost.
- Candidate checks and post-promotion checks perform no financial, fulfillment, inventory, or order writes. Readiness configuration checks are not upstream-provider availability tests.
- Rollback restores **traffic**, not database schema, secrets, external registrations, or service settings. Database changes must use expand/contract: additive, backward-compatible migrations first; destructive cleanup only in a later release after the rollback window. No migration changes are included here.
- A killed runner or unavailable Cloud Run control plane can prevent automatic rollback. The workflow logs the previous allocation; an operator can use `gcloud run services update-traffic SERVICE --to-revisions=CAPTURED_ALLOCATION --region=asia-east1 --project=battle-bus-509406`.
- Bus registration with Inngest remains after promotion. If registration partially succeeds and fails, traffic rollback cannot guarantee registry restoration; re-sync the restored endpoint before considering recovery complete.
- Older open browser sessions can still need a refresh when frontend asset versions change. Long-running requests, dependency outages, and regional failures remain outside this rollout guarantee.

## Verification

Local tests exercise successful promotion, failed production probes, partial promotion failure, registration failure, and restoration of an 80/20 traffic split without touching GCP. Live Actions checks validate the real candidate and canonical service separately.

## References

- [Cloud Run minimum instances](https://docs.cloud.google.com/run/docs/configuring/min-instances)
- [Cloud Run traffic migration and rollback](https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration)
