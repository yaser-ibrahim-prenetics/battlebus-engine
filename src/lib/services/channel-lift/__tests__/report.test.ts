import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "@/lib/config";
import { tripleWhaleAttributionConfigHash } from "@/lib/clients/triple-whale";
import {
  finalizeChannelLiftEvidence,
  prepareChannelLiftCandidateBatch,
  prepareChannelLiftDeliveryBatch,
  prepareChannelLiftPlan,
} from "@/lib/services/channel-lift/report";

const original = { ...config.channelLift };
const originalShop = config.shopify.im8.shopDomain;
const reportingDate = "2026-10-28";
const eligibilityCutoffSeconds = 1_793_275_200;

const order = {
  id: "123",
  processedAt: "2026-10-28T12:00:00Z",
  currency: "USD",
  totalPrice: "12.30",
  test: false,
  cancelledAt: null,
  financialStatus: "paid",
  sourceName: "web",
  email: "person@example.com",
  customerId: "456",
};

function extractionConfigHash(): string {
  return tripleWhaleAttributionConfigHash({
    reportingDate,
    shopId: "im8store.myshopify.com",
    pageSize: config.channelLift.pageSize,
    maxRows: config.channelLift.maxRows,
  });
}

function candidateDependencies({
  rows = [{ orderId: "123", channel: "klaviyo", eventDate: reportingDate }],
  orders = new Map([["123", order]]),
  counts = { rows: rows.length, orders: rows.length, pairs: rows.length },
  mappedPairs = rows.length,
} = {}) {
  return {
    readCounts: vi.fn().mockResolvedValue(counts),
    readPairCount: vi.fn().mockResolvedValue(mappedPairs),
    readPairPage: vi.fn().mockResolvedValue(rows),
    readOrders: vi.fn().mockResolvedValue(orders),
  };
}

describe("channel-lift report preparation", () => {
  beforeEach(() => {
    Object.assign(config.channelLift, {
      ...original,
      tripleWhaleShopId: "im8store.myshopify.com",
      tripleWhaleApiKey: "secret",
      sourceUrl: "https://im8health.com/",
      metaDatasetId: "123",
      maxEventAgeSeconds: 604_800,
    });
    Object.assign(config.shopify.im8, { shopDomain: "im8store.myshopify.com" });
  });

  it("creates a bounded plan and privacy-safe evidence", async () => {
    const plan = await prepareChannelLiftPlan(reportingDate, {
      readSummary: vi.fn().mockResolvedValue({
        counts: { rows: 2, orders: 2, pairs: 2 },
        channels: [
          { channel: "klaviyo", rows: 1, pairs: 1 },
          { channel: "other", rows: 1, pairs: 1 },
        ],
        configHash: extractionConfigHash(),
        snapshotHash: "b".repeat(64),
      }),
    });
    const prepared = await prepareChannelLiftCandidateBatch(
      {
        reportingDate,
        eligibilityCutoffSeconds,
        expectedCounts: plan.counts,
        expectedMappedPairs: plan.mappedPairs,
        candidateBatch: plan.candidateBatches[0],
      },
      candidateDependencies({ counts: plan.counts, mappedPairs: plan.mappedPairs })
    );
    const evidence = finalizeChannelLiftEvidence({
      plan,
      preparedBatches: [
        {
          batch: prepared.batch,
          exclusionCounts: prepared.exclusionCounts,
          configHash: prepared.configHash,
        },
      ],
      eligibilityCutoffSeconds,
    });

    expect(prepared.events).toHaveLength(1);
    expect(plan.candidateBatches).toEqual([{ candidateOffset: 0, candidateCount: 1 }]);
    expect(evidence).toMatchObject({
      mappedPairs: 1,
      eligibleEvents: 1,
      exclusionCounts: { unknown_channel: 1 },
    });
    expect(JSON.stringify({ plan, evidence })).not.toContain("person@example.com");
  });

  it("fails closed when Triple Whale and Shopify shop identities differ", async () => {
    Object.assign(config.shopify.im8, { shopDomain: "different.myshopify.com" });
    await expect(prepareChannelLiftPlan(reportingDate, { readSummary: vi.fn() })).rejects.toThrow(
      "shop_identity_mismatch"
    );
  });

  it("holds missing and ineligible Shopify orders by safe reason", async () => {
    const plan = await prepareChannelLiftPlan(reportingDate, {
      readSummary: vi.fn().mockResolvedValue({
        counts: { rows: 2, orders: 2, pairs: 2 },
        channels: [{ channel: "klaviyo", rows: 2, pairs: 2 }],
        configHash: extractionConfigHash(),
        snapshotHash: "b".repeat(64),
      }),
    });
    const rows = [
      { orderId: "123", channel: "klaviyo", eventDate: reportingDate },
      { orderId: "124", channel: "klaviyo", eventDate: reportingDate },
    ];
    const prepared = await prepareChannelLiftCandidateBatch(
      {
        reportingDate,
        eligibilityCutoffSeconds,
        expectedCounts: plan.counts,
        expectedMappedPairs: plan.mappedPairs,
        candidateBatch: plan.candidateBatches[0],
      },
      candidateDependencies({
        rows,
        counts: plan.counts,
        mappedPairs: plan.mappedPairs,
        orders: new Map([["123", { ...order, financialStatus: "pending" }]]),
      })
    );
    const evidence = finalizeChannelLiftEvidence({
      plan,
      preparedBatches: [
        {
          batch: prepared.batch,
          exclusionCounts: prepared.exclusionCounts,
          configHash: prepared.configHash,
        },
      ],
      eligibilityCutoffSeconds,
    });
    expect(prepared.events).toHaveLength(0);
    expect(evidence.deliveryBatches[0].eventCount).toBe(0);
    expect(evidence.exclusionCounts).toEqual({
      cancelled_refunded_or_unpaid: 1,
      shopify_order_missing_or_mismatched: 1,
    });
  });

  it("binds each safe batch digest to the complete outbound payload", async () => {
    const input = {
      reportingDate,
      eligibilityCutoffSeconds,
      expectedCounts: { rows: 1, orders: 1, pairs: 1 },
      expectedMappedPairs: 1,
      candidateBatch: { candidateOffset: 0, candidateCount: 1 },
    };
    const first = await prepareChannelLiftCandidateBatch(input, candidateDependencies());
    const changed = await prepareChannelLiftCandidateBatch(
      input,
      candidateDependencies({
        orders: new Map([["123", { ...order, email: "changed@example.com", totalPrice: "99.00" }]]),
      })
    );
    expect(changed.events[0].event_id).toBe(first.events[0].event_id);
    expect(changed.configHash).toBe(first.configHash);
    expect(changed.batch.digest).not.toBe(first.batch.digest);
    expect(JSON.stringify(changed.batch)).not.toContain("changed@example.com");
  });

  it("reconstructs only the requested candidate batch and matches its digest", async () => {
    const expectedCounts = { rows: 1, orders: 1, pairs: 1 };
    const prepared = await prepareChannelLiftCandidateBatch(
      {
        reportingDate,
        eligibilityCutoffSeconds,
        expectedCounts,
        expectedMappedPairs: 1,
        candidateBatch: { candidateOffset: 0, candidateCount: 1 },
      },
      candidateDependencies()
    );
    const dependencies = candidateDependencies();
    const batch = await prepareChannelLiftDeliveryBatch(
      {
        reportingDate,
        eligibilityCutoffSeconds,
        expectedCounts,
        expectedMappedPairs: 1,
        batch: prepared.batch,
      },
      dependencies
    );
    expect(batch.events).toHaveLength(1);
    expect(batch.digest).toBe(prepared.batch.digest);
    expect(batch.configHash).toBe(prepared.configHash);
    expect(dependencies.readOrders).toHaveBeenCalledWith(["123"]);
  });

  afterAll(() => {
    Object.assign(config.channelLift, original);
    Object.assign(config.shopify.im8, { shopDomain: originalShop });
  });
});
