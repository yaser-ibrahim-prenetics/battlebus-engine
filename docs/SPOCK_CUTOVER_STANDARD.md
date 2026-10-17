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

