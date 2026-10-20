# Spock replacement cutover standard

Reference: Spock Store develop at `66540e77d4f415c8280d59816e320c712a83b53d`.
Both change branches start from `codex/durable-workflows-timelines`.

## Required evidence

A build or a unit-test pass does not certify replacement readiness. The registry in
`config/spock-workflows.json` conservatively includes non-Europa capabilities,
including CircleDNA, Extensiv, Prive, administrative replay and the newly added
Dynamics reconciliation. Their production activity is not assumed absent.

For every registered workflow, require version-bound automated contract runs,
historical production replays, shadow observations, and recovery drill evidence.
Compare financial, order, fulfillment and inventory effects, including explicit
empty results for domains with no effects. Missing adapters, missing snapshots,
errors, duplicate output identities and mismatches block the gate. Preserve every
discrepancy; a later passing sample does not erase an earlier failure.

## Implementation boundaries

Domain decisions and comparison rules have no database, cloud or queue dependency.
Adapters normalize provider records at their boundaries. The replay runner passes
the same immutable input and frozen context to both adapters. Never route a replay
into live mutation endpoints. An isolated environment must use capture-only
provider adapters and its own storage, queue IDs and credentials.

Historical payloads and recorded provider reads can contain customer data; keep
them in approved private storage. Only input hashes, output hashes, discrepancy
paths and run provenance belong in the cutover evidence tables or Hub.
Production replay and sustained shadow operation require approved inputs and
isolated adapters; they cannot be established using synthetic fixtures.

## Release sequence

1. Apply expand-only migrations before deploying application and Hub revisions.
2. Run paired contract cases against the pinned Spock revision and candidate Bus.
3. Import approved historical cases with frozen provider-read context and compare effects.
4. Mirror production inputs to isolated replay workers while Spock remains the writer.
5. Run fault, retry, duplicate and replay drills; inspect durable evidence and SLOs.
6. Review every remaining gap. Do not disable a capability to make the gate pass.
7. Obtain operational sign-off for traffic switching and keep the Spock rollback path.

This PR does not switch production traffic or certify evidence that has not been collected.

## Current implementation status

This change implements an evidence/reporting foundation, not complete Spock replacement.
The workflow registry deliberately marks full paired workflow adapters as
`not_implemented`; these entries block readiness even if someone imports positive
sample counts. The shipping component contract executes the actual pinned Spock
function and the extracted Bus policy, but is not an end-to-end workflow test.
All other provider-heavy business logic has not yet been extracted.

The paired runner validates and freezes identical payload/context copies, applies
deadlines, compares strict business-output schemas, and persists hashes/provenance.
Trusted executable adapters must be supplied in an approved isolated worker.
`CUTOVER_ISOLATED_WORKER=true` is an operator prerequisite, NOT network isolation.
This PR does not provide production adapters, a live mirroring transport, frozen
provider-context capture, or automated fault-injection drills. Never import live
Spock or Bus handlers into the worker with production credentials.

The existing structured reconciliation history remains intact; cutover execution
evidence adds an append-only trail rather than replacing it.

## Commands

```sh
SPOCK_REFERENCE_DIR=/approved/spock-checkout npm run test:spock-contract
CUTOVER_ISOLATED_WORKER=true npm run cutover:replay -- /private/cases.jsonl /approved/spock-adapter.mjs /approved/bus-adapter.mjs
```

Each adapter exports a default `ReplayAdapter` (see `contracts.ts`) and must supply
its actual immutable source revision. The Spock revision must equal the registry.
Cases are JSONL `ReplayCase` objects, with opaque case/source identifiers, workflow,
mode, provenance, capture time, payload, and frozen provider-read context. Only
metadata and hashes are persisted; input files must remain in approved private
storage and outside version control. Deadline aborts are cooperative: worker
isolation must prevent side effects even when an adapter ignores its AbortSignal.

GET `/api/admin/cutover?revision=<git-sha>` requires `BATTLE_BUS_API_KEY`.
HTTP 200 returns an assessment, not approval. Evidence/storage/probe failures
return unavailable; an undeployed candidate cannot pass using current health.
Battle Hub requires its server-side `BATTLE_BUS_API_KEY` to match.
No credentials should be exposed through client environment variables.

## Operational objectives and remaining blockers

Provisional targets: p95 event-to-completion <= 30 minutes, terminal failure rate
<= 1%, oldest running/unpublished item <= 1 hour; minimum 100 completed samples.
These are not business-approved targets. Intentional 24-hour refund holds and
workflow sleeps are included; workflow-specific objectives must be agreed before
cutover. Metrics cover instrumented Inngest executions and the durable event outbox,
not missing events or every external provider's internal queue. Cancelled runs
without terminal hooks remain visible as backlog.

Configuration checks do not certify dependency access. The authenticated report
adds bounded read probes for Shopify, Dynamics and both GPS warehouses; enabled
dependencies without probes remain `unverified`. Public process readiness is
unchanged. Probes are shared and cached for 30 seconds. GPS/Dynamics clients may
finish their read after the report deadline; no mutation probe is used.

Remaining release blockers: all full-workflow adapters and component extraction,
approved historical payloads/context, isolated shadow transport/environment,
seven complete UTC observation days, named recovery/fault drills, complete
authenticated dependency probes, operational SLO approval and final cutover sign-off.
The numeric recovery threshold is only a minimum sample count, not proof of all
fault scenarios. The gate must not be used as automatic traffic-switch authority.

