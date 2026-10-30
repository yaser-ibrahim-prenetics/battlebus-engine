# 001: Cutover health sample boundaries

- Date: 2026-10-21
- Status: Accepted

## Context

Inngest completion can contain business failures. Revision-filtered queries also hid unfinished work from previous deployments.

## Decision

Classify documented business result envelopes, including nested reconciliation failures. Retain skipped, simulated and deferred runs with an additive sample-exclusion flag. They do not contribute to completed-sample, error-rate or latency calculations. Completed samples are candidate-revision-specific; running backlog spans every revision.

## Rationale

A successful invocation is not necessarily successful business processing. Deploying a new revision does not resolve older work. Do not recursively interpret arbitrary provider/customer objects as workflow outcomes.

## Consequences

New result envelopes must extend the classifier and regression tests. Apply migration 65 before deploying. Candidate SHAs must change with code; old misclassified completions are not reusable candidate evidence. Deferred obligations and cancelled runs still need dedicated lifecycle/queue coverage; these metrics alone do not certify cutover.
