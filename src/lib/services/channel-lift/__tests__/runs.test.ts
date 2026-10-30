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
import { channelLiftRunId } from "@/lib/channel-lift/model";

const row = {
  run_id: channelLiftRunId("2026-10-28", "live"),
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
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ request_id: row.request_id }],
    });
  });

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
    expect(mocks.query).toHaveBeenCalledTimes(4);
  });

  it("audits a different request identity before resuming a failed partial run", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ ...row, status: "failed" }] });
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ request_id: "new" }] });
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [row] });
    await expect(
      startChannelLiftRun({
        reportingDate: "2026-10-28",
        mode: "live",
        source: "manual",
        requestId: "da90cc5c-b1a2-4245-8ea4-bc57a10481ed",
        reasonCode: "operator_replay",
        referenceId: "BB-127",
      })
    ).resolves.toMatchObject({
      disposition: "started",
      acceptedRequestId: "da90cc5c-b1a2-4245-8ea4-bc57a10481ed",
      acceptedSource: "manual",
      run: { requestId: "ca90cc5c-b1a2-4245-8ea4-bc57a10481ed" },
    });
    expect(mocks.query).toHaveBeenCalledTimes(5);
    expect(mocks.query.mock.calls[3][1]).toEqual([
      "da90cc5c-b1a2-4245-8ea4-bc57a10481ed",
      row.run_id,
      "live",
      "manual",
      null,
      "operator_replay",
      "BB-127",
    ]);
  });

  it("does not treat a cross-mode unique collision as the requested reservation", async () => {
    mocks.query.mockRejectedValueOnce({ code: "23505" });
    mocks.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          ...row,
          run_id: `channel_lift_${"b".repeat(64)}`,
          mode: "dry_run",
        },
      ],
    });
    await expect(
      startChannelLiftRun({
        reportingDate: "2026-10-28",
        mode: "live",
        source: "manual",
        requestId: "ca90cc5c-b1a2-4245-8ea4-bc57a10481ed",
        reasonCode: "live_canary",
      })
    ).resolves.toMatchObject({ disposition: "active", run: { mode: "dry_run" } });
  });

  it("does not claim an original request under a different source", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    mocks.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ...row, status: "queued", source: "schedule" }],
    });
    await expect(
      startChannelLiftRun({
        reportingDate: "2026-10-28",
        mode: "live",
        source: "manual",
        requestId: "ca90cc5c-b1a2-4245-8ea4-bc57a10481ed",
        reasonCode: "live_canary",
      })
    ).resolves.toMatchObject({
      disposition: "active",
      acceptedSource: "schedule",
    });
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it("fails closed when a replay request identity conflicts with its audit row", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ ...row, status: "failed" }] });
    mocks.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    mocks.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          run_id: row.run_id,
          mode: "live",
          source: "manual",
          requested_by: null,
          reason_code: "incident_recovery",
          reference_id: "BB-999",
        },
      ],
    });
    await expect(
      startChannelLiftRun({
        reportingDate: "2026-10-28",
        mode: "live",
        source: "manual",
        requestId: "da90cc5c-b1a2-4245-8ea4-bc57a10481ed",
        reasonCode: "operator_replay",
        referenceId: "BB-127",
      })
    ).rejects.toThrow("request_audit_conflict");
    expect(mocks.query.mock.calls[4][1]).toEqual([
      "da90cc5c-b1a2-4245-8ea4-bc57a10481ed",
      row.run_id,
    ]);
  });

  it("binds a request ID to one mode and source across date ranges", async () => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    mocks.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ mode: "dry_run", source: "manual" }],
    });
    await expect(
      startChannelLiftRun({
        reportingDate: "2026-10-28",
        mode: "live",
        source: "manual",
        requestId: "ca90cc5c-b1a2-4245-8ea4-bc57a10481ed",
        reasonCode: "live_canary",
      })
    ).rejects.toThrow("request_identity_conflict");
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
