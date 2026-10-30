import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ChannelLiftError,
  channelLiftRunId,
  type MetaChannelLiftEvent,
} from "@/lib/channel-lift/model";

const mocks = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  preparePlan: vi.fn(),
  prepareCandidate: vi.fn(),
  finalize: vi.fn(),
  prepareBatch: vi.fn(),
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
  prepareChannelLiftPlan: mocks.preparePlan,
  prepareChannelLiftCandidateBatch: mocks.prepareCandidate,
  finalizeChannelLiftEvidence: mocks.finalize,
  prepareChannelLiftDeliveryBatch: mocks.prepareBatch,
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

const runId = channelLiftRunId("2026-10-28", "live");
const dryRunId = channelLiftRunId("2026-10-28", "dry_run");
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
  deliveryBatches: [
    { candidateOffset: 0, candidateCount: 1, eventCount: 1, digest: "d".repeat(64) },
  ],
};
const plan = {
  counts: evidence.counts,
  mappedPairs: evidence.mappedPairs,
  mappingExclusions: {},
  extractionConfigHash: "a".repeat(64),
  extractionSnapshotHash: "f".repeat(64),
  candidateBatches: [{ candidateOffset: 0, candidateCount: 1 }],
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
      acceptedRequestId: "request",
      acceptedSource: "manual",
      run: {
        runId,
        reportingDate: "2026-10-28",
        mode: "live",
        source: "manual",
        requestId: "request",
        eligibilityCutoffSeconds: 1_798_000_000,
        attemptedEvents: 0,
        deliveredEvents: 0,
        batchCount: 0,
      },
    });
    mocks.preparePlan.mockResolvedValue(plan);
    mocks.prepareCandidate.mockResolvedValue({
      events: [event],
      batch: evidence.deliveryBatches[0],
      exclusionCounts: {},
      configHash: evidence.configHash,
    });
    mocks.finalize.mockReturnValue(evidence);
    mocks.prepareBatch.mockResolvedValue({
      events: [event],
      digest: evidence.deliveryBatches[0].digest,
      configHash: evidence.configHash,
    });
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
    mocks.start.mockResolvedValue({
      disposition: "started",
      acceptedRequestId: "request",
      acceptedSource: "manual",
      run: {
        runId: dryRunId,
        reportingDate: "2026-10-28",
        mode: "dry_run",
        source: "manual",
        requestId: "request",
        eligibilityCutoffSeconds: 1_798_000_000,
        attemptedEvents: 0,
        deliveredEvents: 0,
      },
    });
    const handler = processMetaChannelLift as unknown as (
      input: ReturnType<typeof invocation>
    ) => Promise<Record<string, unknown>>;
    const result = await handler(invocation("dry_run"));
    expect(result).toMatchObject({ status: "dry_run_completed", eligibleEvents: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(dryRunId, "dry_run");
  });

  it("rejects a reservation that does not match the requested mode", async () => {
    mocks.start.mockResolvedValue({
      disposition: "started",
      acceptedRequestId: "request",
      acceptedSource: "manual",
      run: {
        runId,
        reportingDate: "2026-10-28",
        mode: "dry_run",
        source: "manual",
        requestId: "request",
        eligibilityCutoffSeconds: 1_798_000_000,
        attemptedEvents: 0,
        deliveredEvents: 0,
      },
    });
    await expect(
      (
        processMetaChannelLift as unknown as (
          input: ReturnType<typeof invocation>
        ) => Promise<Record<string, unknown>>
      )(invocation("live"))
    ).resolves.toEqual({ status: "reservation_mismatch", runId });
    expect(mocks.preparePlan).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("checkpoints bounded live batches and progress", async () => {
    const events = Array.from({ length: 501 }, (_, index) => ({
      ...event,
      event_id: `event-${index}`,
    }));
    const deliveryBatches = [
      { candidateOffset: 0, candidateCount: 500, eventCount: 500, digest: "d".repeat(64) },
      { candidateOffset: 500, candidateCount: 1, eventCount: 1, digest: "e".repeat(64) },
    ];
    mocks.preparePlan.mockResolvedValue({
      ...plan,
      mappedPairs: 501,
      candidateBatches: deliveryBatches.map(({ candidateOffset, candidateCount }) => ({
        candidateOffset,
        candidateCount,
      })),
    });
    mocks.prepareCandidate.mockImplementation(
      async ({ candidateBatch }: { candidateBatch: { candidateOffset: number } }) => ({
        events: [],
        batch: deliveryBatches.find(
          (batch) => batch.candidateOffset === candidateBatch.candidateOffset
        ),
        exclusionCounts: {},
        configHash: evidence.configHash,
      })
    );
    mocks.finalize.mockReturnValue({ ...evidence, eligibleEvents: 501, deliveryBatches });
    mocks.prepareBatch.mockImplementation(
      async ({ batch }: { batch: (typeof deliveryBatches)[number] }) => ({
        events: events.slice(batch.candidateOffset, batch.candidateOffset + batch.eventCount),
        digest: batch.digest,
        configHash: evidence.configHash,
      })
    );
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
    expect(mocks.preparePlan).toHaveBeenCalledTimes(1);
    expect(mocks.prepareCandidate).toHaveBeenCalledTimes(2);
    expect(mocks.prepareBatch).toHaveBeenCalledTimes(2);
    expect(mocks.progress).toHaveBeenLastCalledWith({
      runId,
      batchCount: 2,
      attemptedEvents: 501,
      deliveredEvents: 501,
    });
  });

  it("fails closed when provider data drifts before a delivery checkpoint", async () => {
    mocks.prepareBatch.mockResolvedValueOnce({
      events: [{ ...event, custom_data: { value: 99, currency: "USD" } }],
      digest: "f".repeat(64),
      configHash: evidence.configHash,
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

  it("resumes after the last confirmed batch without resending it", async () => {
    const events = Array.from({ length: 501 }, (_, index) => ({
      ...event,
      event_id: `event-${index}`,
    }));
    const deliveryBatches = [
      { candidateOffset: 0, candidateCount: 500, eventCount: 500, digest: "d".repeat(64) },
      { candidateOffset: 500, candidateCount: 1, eventCount: 1, digest: "e".repeat(64) },
    ];
    mocks.start.mockResolvedValue({
      disposition: "started",
      acceptedRequestId: "request",
      acceptedSource: "manual",
      run: {
        runId,
        reportingDate: "2026-10-28",
        mode: "live",
        source: "manual",
        requestId: "request",
        eligibilityCutoffSeconds: 1_798_000_000,
        attemptedEvents: 501,
        deliveredEvents: 500,
        batchCount: 2,
      },
    });
    mocks.preparePlan.mockResolvedValue({
      ...plan,
      mappedPairs: 501,
      candidateBatches: deliveryBatches.map(({ candidateOffset, candidateCount }) => ({
        candidateOffset,
        candidateCount,
      })),
    });
    mocks.prepareCandidate.mockImplementation(
      async ({ candidateBatch }: { candidateBatch: { candidateOffset: number } }) => ({
        events: [],
        batch: deliveryBatches.find(
          (batch) => batch.candidateOffset === candidateBatch.candidateOffset
        ),
        exclusionCounts: {},
        configHash: evidence.configHash,
      })
    );
    mocks.finalize.mockReturnValue({ ...evidence, eligibleEvents: 501, deliveryBatches });
    mocks.prepareBatch.mockResolvedValue({
      events: [events[500]],
      digest: deliveryBatches[1].digest,
      configHash: evidence.configHash,
    });
    await expect(
      (
        processMetaChannelLift as unknown as (
          input: ReturnType<typeof invocation>
        ) => Promise<Record<string, unknown>>
      )(invocation("live"))
    ).resolves.toMatchObject({ status: "completed", deliveredEvents: 501, batchCount: 2 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.prepareBatch).toHaveBeenCalledWith(
      expect.objectContaining({ batch: deliveryBatches[1] })
    );
  });

  it("revalidates an empty candidate batch without calling Meta", async () => {
    const deliveryBatches = [
      { candidateOffset: 0, candidateCount: 500, eventCount: 0, digest: "a".repeat(64) },
      { candidateOffset: 500, candidateCount: 1, eventCount: 1, digest: "d".repeat(64) },
    ];
    mocks.preparePlan.mockResolvedValue({
      ...plan,
      mappedPairs: 501,
      candidateBatches: deliveryBatches.map(({ candidateOffset, candidateCount }) => ({
        candidateOffset,
        candidateCount,
      })),
    });
    mocks.prepareCandidate.mockImplementation(
      async ({ candidateBatch }: { candidateBatch: { candidateOffset: number } }) => ({
        events: [],
        batch: deliveryBatches.find(
          (batch) => batch.candidateOffset === candidateBatch.candidateOffset
        ),
        exclusionCounts: {},
        configHash: evidence.configHash,
      })
    );
    mocks.finalize.mockReturnValue({ ...evidence, deliveryBatches });
    mocks.prepareBatch.mockImplementation(
      async ({ batch }: { batch: (typeof deliveryBatches)[number] }) => ({
        events: batch.eventCount === 0 ? [] : [event],
        digest: batch.digest,
        configHash: evidence.configHash,
      })
    );
    await expect(
      (
        processMetaChannelLift as unknown as (
          input: ReturnType<typeof invocation>
        ) => Promise<Record<string, unknown>>
      )(invocation("live"))
    ).resolves.toMatchObject({ status: "completed", batchCount: 1, deliveredEvents: 1 });
    expect(mocks.prepareBatch).toHaveBeenCalledTimes(2);
    expect(mocks.send).toHaveBeenCalledTimes(1);
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
    expect(mocks.progress).toHaveBeenCalledWith({
      runId,
      batchCount: 1,
      attemptedEvents: 1,
      deliveredEvents: 0,
    });
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
