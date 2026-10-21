# 002: Isolated replay evidence writer

- Date: 2026-10-21
- Status: Accepted

## Context

The candidate runtime previously inherited permission to insert the parity evidence used to assess itself.

## Decision

Migration 43 creates a dedicated NOLOGIN replay writer group. Migration 44 grants it append-only evidence insertion and removes insertion from runtime roles. Runtime retains read access. The CLI checks writer membership and rejects identities inheriting service_role before loading adapters.

## Rationale

Independent replay evidence should not be forgeable through the normal runtime database identity. Runtime workflow-health telemetry remains self-reported and is not an independent attestation.

## Consequences

An administrator must provision a separate approved worker login/IAM database user and grant only battle_bus_replay_writer. No cloud identity or production grants are created by this change. Duplicate evidence IDs now fail explicitly instead of silently dropping conflicting submissions. Network isolation and trusted adapters remain mandatory; administrators can still override database permissions.
