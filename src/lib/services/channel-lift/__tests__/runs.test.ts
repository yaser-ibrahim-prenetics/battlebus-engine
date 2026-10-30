import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db/database", () => ({
  isDatabaseConfigured: () => true,
  queryDatabase: mocks.query,
}));

import {
  completeChannelLiftRun,
  failChannelLiftRun,
  recordChannelLiftPrepared,
  startChannelLiftRun,
} from "@/lib/services/channel-lift/runs";

const row = {
  run_id: `channel_lift_${"a".repeat(64)}`,
  reporting_date: "2026-10-28",
  mode: "live",
  source: "manual",
  request_id: "ca90cc5c-b1a2-4245-8ea4-bc57a10481ed",
  status: "running",
  attempts: 1,
  expected_rows: null,
  expected_orders: null,
  expected_pairs: null,
  mapped_pairs: null,
  eligible_events: null,
  exclusion_counts: {},
  batch_count: 0,
  attempted_events: 0,
  delivered_events: 0,
  config_hash: null,
  snapshot_hash: null,
  last_error_code: null,
  eligibility_cutoff_seconds: 1_798_000_000,
};

describe("channel-lift run state", () => {
  beforeEach(() => mocks.query.mockReset());

  it("starts a new deterministic run once", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [row] });
    await expect(
      startChannelLiftRun({
        reportingDate: "2026-10-28",
        mode: "live",
        source: "manual",
        requestId: "ca90cc5c-b1a2-4245-8ea4-bc57a10481ed",
        requestedBy: "operator@example.com",
        reasonCode: "live_canary",
        referenceId: "BB-123",
      })
    ).resolves.toMatchObject({ disposition: "started", run: { status: "running" } });
  });

  it("returns completed work without restarting it", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    mocks.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ...row, status: "completed" }],
    });
    await expect(
      startChannelLiftRun({
        reportingDate: "2026-10-28",
        mode: "live",
        source: "manual",
        requestId: "ca90cc5c-b1a2-4245-8ea4-bc57a10481ed",
        reasonCode: "operator_replay",
        referenceId: "BB-124",
      })
    ).resolves.toMatchObject({ disposition: "already_completed" });
  });

  it("resumes the same running request after an uncertain reservation receipt", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [row] });
    await expect(
      startChannelLiftRun({
        reportingDate: "2026-10-28",
        mode: "live",
        source: "manual",
        requestId: "ca90cc5c-b1a2-4245-8ea4-bc57a10481ed",
        reasonCode: "operator_replay",
        referenceId: "BB-125",
      })
    ).resolves.toMatchObject({ disposition: "started", run: { status: "running" } });
  });

  it("claims a same-request queued row left by a crash after insert", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ ...row, status: "queued" }] });
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [row] });
    await expect(
      startChannelLiftRun({
        reportingDate: "2026-10-28",
        mode: "live",
        source: "manual",
        requestId: "ca90cc5c-b1a2-4245-8ea4-bc57a10481ed",
        reasonCode: "operator_replay",
        referenceId: "BB-126",
      })
    ).resolves.toMatchObject({ disposition: "started", run: { status: "running" } });
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it("rejects a different request identity for a failed partial run", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ ...row, status: "failed" }] });
    await expect(
      startChannelLiftRun({
        reportingDate: "2026-10-28",
        mode: "live",
        source: "manual",
        requestId: "da90cc5c-b1a2-4245-8ea4-bc57a10481ed",
        reasonCode: "operator_replay",
        referenceId: "BB-127",
      })
    ).resolves.toMatchObject({ disposition: "request_mismatch" });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("persists only bounded aggregate preparation evidence", async () => {
    mocks.query.mockResolvedValue({ rowCount: 1, rows: [{ run_id: row.run_id }] });
    await recordChannelLiftPrepared({
      runId: row.run_id,
      counts: { rows: 3, orders: 2, pairs: 2 },
      mappedPairs: 2,
      eligibleEvents: 1,
      exclusionCounts: { unknown_channel: 1 },
      configHash: "b".repeat(64),
      snapshotHash: "c".repeat(64),
    });
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain("person@example.com");
  });

  it("uses distinct terminal states for dry-run, live, and failure", async () => {
    mocks.query.mockResolvedValue({ rowCount: 1, rows: [{ run_id: row.run_id }] });
    await completeChannelLiftRun(row.run_id, "dry_run");
    await completeChannelLiftRun(row.run_id, "live");
    await failChannelLiftRun(row.run_id, "unsafe detail with spaces");
    expect(mocks.query.mock.calls[0][1]).toEqual([row.run_id, "dry_run_completed"]);
    expect(mocks.query.mock.calls[1][1]).toEqual([row.run_id, "completed"]);
    expect(mocks.query.mock.calls[2][1]).toEqual([row.run_id, "channel_lift_failure"]);
  });
});
