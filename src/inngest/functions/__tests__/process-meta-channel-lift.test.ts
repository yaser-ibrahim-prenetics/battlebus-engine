import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChannelLiftError, type MetaChannelLiftEvent } from "@/lib/channel-lift/model";

const mocks = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  prepare: vi.fn(),
  send: vi.fn(),
  start: vi.fn(),
  prepared: vi.fn(),
  progress: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
}));

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (options: Record<string, unknown>, handler: unknown) => {
      mocks.options = options;
      return handler;
    },
  },
}));
vi.mock("@/lib/config", () => ({
  config: {
    channelLift: {
      enabled: true,
      sendEnabled: true,
      metaDatasetId: "123",
      metaAccessToken: "secret",
    },
  },
}));
vi.mock("@/lib/services/channel-lift/report", () => ({
  prepareChannelLiftReport: mocks.prepare,
}));
vi.mock("@/lib/clients/meta-conversions", () => ({
  sendMetaChannelLiftBatch: mocks.send,
}));
vi.mock("@/lib/services/channel-lift/runs", () => ({
  startChannelLiftRun: mocks.start,
  recordChannelLiftPrepared: mocks.prepared,
  recordChannelLiftProgress: mocks.progress,
  completeChannelLiftRun: mocks.complete,
  failChannelLiftRun: mocks.fail,
}));

import { processMetaChannelLift } from "@/inngest/functions/process-meta-channel-lift";

const runId = `channel_lift_${"a".repeat(64)}`;
const event: MetaChannelLiftEvent = {
  event_name: "Purchase_Klaviyo",
  event_id: "event-1",
  event_time: 1_798_000_000,
  action_source: "website",
  event_source_url: "https://im8health.com/",
  user_data: { em: ["hash"] },
  custom_data: { value: 12.3, currency: "USD" },
};
const evidence = {
  counts: { rows: 1, orders: 1, pairs: 1 },
  mappedPairs: 1,
  eligibleEvents: 1,
  exclusionCounts: {},
  configHash: "b".repeat(64),
  snapshotHash: "c".repeat(64),
};

function step() {
  return {
    run: vi.fn(async (_id: string, handler: () => Promise<unknown>) => handler()),
  };
}

function invocation(mode: "dry_run" | "live", attempt = 0) {
  return {
    event: {
      id: "request",
      name: "meta.channel-lift/run.requested",
      data: {
        requestId: "request",
        reportingDate: "2026-10-28",
        mode,
        source: "manual",
      },
    },
    step: step(),
    attempt,
  };
}

describe("Meta channel-lift workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.start.mockResolvedValue({
      disposition: "started",
      run: {
        runId,
        reportingDate: "2026-10-28",
        eligibilityCutoffSeconds: 1_798_000_000,
      },
    });
    mocks.prepare.mockResolvedValue({ events: [event], evidence });
    mocks.send.mockResolvedValue({ eventsReceived: 1 });
    mocks.prepared.mockResolvedValue(undefined);
    mocks.progress.mockResolvedValue(undefined);
    mocks.complete.mockResolvedValue(undefined);
    mocks.fail.mockResolvedValue(undefined);
  });

  it("serializes runs by reporting date", () => {
    expect(mocks.options?.idempotency).toBe(
      "event.data.requestId + ':' + event.data.reportingDate + ':' + event.data.mode"
    );
    expect(mocks.options?.concurrency).toEqual([
      { limit: 1, key: "event.data.reportingDate" },
      { limit: 2 },
    ]);
  });

  it("completes a dry-run without any Meta write", async () => {
    const handler = processMetaChannelLift as unknown as (
      input: ReturnType<typeof invocation>
    ) => Promise<Record<string, unknown>>;
    const result = await handler(invocation("dry_run"));
    expect(result).toMatchObject({ status: "dry_run_completed", eligibleEvents: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(runId, "dry_run");
  });

  it("checkpoints bounded live batches and progress", async () => {
    const events = Array.from({ length: 501 }, (_, index) => ({
      ...event,
      event_id: `event-${index}`,
    }));
    mocks.prepare.mockResolvedValue({ events, evidence: { ...evidence, eligibleEvents: 501 } });
    mocks.send.mockImplementation(async ({ events: batch }: { events: unknown[] }) => ({
      eventsReceived: batch.length,
    }));
    const handler = processMetaChannelLift as unknown as (
      input: ReturnType<typeof invocation>
    ) => Promise<Record<string, unknown>>;
    const result = await handler(invocation("live"));
    expect(result).toMatchObject({
      status: "completed",
      attemptedEvents: 501,
      deliveredEvents: 501,
      batchCount: 2,
    });
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.prepare).toHaveBeenCalledTimes(3);
    expect(mocks.progress).toHaveBeenLastCalledWith({
      runId,
      batchCount: 2,
      attemptedEvents: 501,
      deliveredEvents: 501,
    });
  });

  it("fails closed when provider data drifts before a delivery checkpoint", async () => {
    mocks.prepare
      .mockResolvedValueOnce({ events: [event], evidence })
      .mockResolvedValueOnce({
        events: [{ ...event, custom_data: { value: 99, currency: "USD" } }],
        evidence: { ...evidence, snapshotHash: "d".repeat(64) },
      });
    await expect(
      (
        processMetaChannelLift as unknown as (
          input: ReturnType<typeof invocation>
        ) => Promise<Record<string, unknown>>
      )(invocation("live"))
    ).resolves.toEqual({ status: "failed", runId, errorCode: "prepared_snapshot_changed" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("fails closed on an ambiguous Meta receipt", async () => {
    mocks.send.mockRejectedValue(new ChannelLiftError("meta_receipt_mismatch"));
    await expect(
      (
        processMetaChannelLift as unknown as (
          input: ReturnType<typeof invocation>
        ) => Promise<Record<string, unknown>>
      )(invocation("live"))
    ).resolves.toEqual({ status: "failed", runId, errorCode: "meta_receipt_mismatch" });
    expect(mocks.fail).toHaveBeenCalledWith(runId, "meta_receipt_mismatch");
  });

  it("lets Inngest retry transient failures before recording a terminal failure", async () => {
    mocks.send.mockRejectedValue(new ChannelLiftError("meta_unavailable", true));
    await expect(
      (
        processMetaChannelLift as unknown as (
          input: ReturnType<typeof invocation>
        ) => Promise<Record<string, unknown>>
      )(invocation("live", 0))
    ).rejects.toThrow("meta_unavailable");
    expect(mocks.fail).not.toHaveBeenCalled();
  });
});
