import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registrations: [] as Array<{
    options: Record<string, any>;
    handler: (args: any) => Promise<any>;
  }>,
  send: vi.fn(async () => ({})),
  acquireLease: vi.fn(async () => ({
    shopifyStore: "lease-test.myshopify.com",
    orderId: "1001",
    token: "lease-token",
    expiresAt: "2026-10-29T00:10:00.000Z",
    operationKey: "manual-retry-1:manual-retry:1",
    owner: "backorder/retry:manual-run-1",
    leaseSeconds: 600,
  })),
  renewLease: vi.fn(async (lease: unknown) => lease),
  releaseLease: vi.fn(async () => undefined),
  createOutboundOrder: vi.fn(async () => ({
    response: { data: [{ orderNo: "GPS-1001" }] },
  })),
  setGpsOrderMetafield: vi.fn(async () => undefined),
  sendOrderUpdate: vi.fn(async () => undefined),
  backorderConfig: {
    enabled: true,
    autoRetryEnabled: true,
    autoRetryMaxAttempts: 1,
    autoRetryIntervalHours: 1,
    maxRetries: 1,
    retryIntervalHours: 1,
    recoveryLeaseSeconds: 600,
  },
}));

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (options: Record<string, any>, handler: (args: any) => Promise<any>) => {
      mocks.registrations.push({ options, handler });
      return handler;
    },
    send: mocks.send,
  },
}));
vi.mock("@/lib/services/order-segments/store", () => ({ readPlan: vi.fn(async () => null) }));
vi.mock("@/lib/services/order-segments/process", () => ({
  processOrderSegments: vi.fn(),
}));
vi.mock("@/lib/services/order-accounting/load", () => ({ loadOrderAccounting: vi.fn() }));
vi.mock("@/lib/services/saudi-short-address", () => ({ loadSaudiShortAddress: vi.fn() }));
vi.mock("@/lib/services/order-segments/recovery", () => ({
  loadEligibleRecoveryOrder: vi.fn(),
}));
vi.mock("@/lib/config", () => ({ config: { features: { dryRunMode: false } } }));
vi.mock("@/lib/clients/gps", () => ({
  createOutboundOrder: mocks.createOutboundOrder,
  isGpsInventoryError: vi.fn(() => true),
}));
vi.mock("@/lib/clients/slack", () => ({
  sendWarningMessage: vi.fn(async () => undefined),
  sendOrderMessage: vi.fn(async () => undefined),
  sendErrorMessage: vi.fn(async () => undefined),
  slackNotificationId: vi.fn(() => "notification-id"),
}));
vi.mock("@/lib/clients/cs-platform", () => ({ sendOrderUpdate: mocks.sendOrderUpdate }));
vi.mock("@/lib/clients/shopify", () => ({
  resolveShopifyAdminCredentials: vi.fn(() => ({ shopDomain: "lease-test.myshopify.com" })),
  getOrder: vi.fn(async () => ({
    id: "1001",
    name: "#1001",
    shipping_address: { country_code: "US" },
    line_items: [{ id: "line-1", sku: "SKU-1", quantity: 1 }],
  })),
  getOrderMetafields: vi.fn(async () => []),
  setGpsOrderMetafield: mocks.setGpsOrderMetafield,
}));
vi.mock("@/lib/transformers/order", () => ({
  toGpsOutboundOrder: vi.fn(() => ({
    platformOrderNo: "SO-1001",
    thirdOrderNo: "1001",
    productList: [{ sku: "SKU-1", quantity: 1 }],
  })),
}));
vi.mock("@/lib/transformers/address", () => ({
  getIm8ShortAddressFromMetafields: vi.fn(() => ""),
}));
vi.mock("@/lib/utils/constants", () => ({
  RETRY_CONFIGS: { DEFAULT: 3 },
  BACKORDER_CONFIGS: mocks.backorderConfig,
}));
vi.mock("@/lib/services/flow-logs", () => ({ logFlowEvent: vi.fn() }));
vi.mock("@/lib/services/run-sequence", () => ({ advanceRunSequence: vi.fn() }));
vi.mock("@/lib/services/backorder-recovery/lease", () => ({
  acquireBackorderRecoveryLease: mocks.acquireLease,
  isBackorderRecoveryBusyError: (error: unknown) =>
    (error as { name?: string })?.name === "BackorderRecoveryBusyError",
  releaseBackorderRecoveryLease: mocks.releaseLease,
  renewBackorderRecoveryLease: mocks.renewLease,
}));

import { processBackorder, processBackorderRetry } from "../process-backorder";

function event(name: "backorder/created" | "backorder/retry") {
  return {
    id: name === "backorder/retry" ? "manual-retry-1" : "backorder-created-1",
    name,
    data: {
      shopifyOrderId: "1001",
      shopifyOrderName: "#1001",
      shopifyStore: "lease-test.myshopify.com",
      d365OrderNumber: "SO-1001",
      warehouse: "GPS Warehouse",
      errorMessage: "out of stock",
      errorType: "out_of_stock",
      failedSkus: ["SKU-1"],
      retryCount: 0,
      maxRetries: 1,
      triggeredBy: name === "backorder/retry" ? "manual" : undefined,
    },
  };
}

function step() {
  return {
    run: vi.fn(async (_name: string, execute: () => Promise<unknown>) => execute()),
    sleep: vi.fn(async () => undefined),
  };
}

describe("backorder recovery serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backorderConfig.enabled = true;
  });

  it("registers created and manual retry events on separate workers", () => {
    expect(mocks.registrations).toHaveLength(2);
    expect(mocks.registrations[0].options.triggers).toEqual([{ event: "backorder/created" }]);
    expect(mocks.registrations[0].options.cancelOn).toEqual([
      { event: "backorder/resolved", match: "data.shopifyOrderId" },
    ]);
    expect(mocks.registrations[1].options.triggers).toEqual([{ event: "backorder/retry" }]);
    for (const registration of mocks.registrations) {
      expect(registration.options.concurrency).toEqual([
        { limit: 5 },
        {
          limit: 1,
          key: "event.data.shopifyStore + ':' + event.data.shopifyOrderId",
        },
      ]);
    }
  });

  it("turns one manual retry event into exactly one leased recovery attempt", async () => {
    const manualStep = step();
    const result = await (processBackorderRetry as unknown as (args: any) => Promise<any>)({
      event: event("backorder/retry"),
      step: manualStep,
      runId: "manual-run-1",
    });

    expect(result).toMatchObject({ status: "resolved", retryCount: 1 });
    expect(manualStep.sleep).not.toHaveBeenCalled();
    expect(mocks.acquireLease).toHaveBeenCalledTimes(1);
    expect(mocks.renewLease).toHaveBeenCalledTimes(1);
    expect(mocks.createOutboundOrder).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ id: "backorder-retry:manual-retry-1:resolved" })
    );
  });

  it("keeps automatic retries on durable sleeps without consuming manual events", async () => {
    const automaticStep = step();
    const result = await (processBackorder as unknown as (args: any) => Promise<any>)({
      event: event("backorder/created"),
      step: automaticStep,
      runId: "automatic-run-1",
    });

    expect(result).toMatchObject({ status: "resolved", retryCount: 1 });
    expect(automaticStep.sleep).toHaveBeenCalledWith("wait-before-auto-retry-1", "1h");
    expect(mocks.acquireLease).toHaveBeenCalledTimes(1);
    expect(mocks.createOutboundOrder).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("durably waits for an active lease instead of consuming the retry", async () => {
    mocks.acquireLease.mockRejectedValueOnce({
      name: "BackorderRecoveryBusyError",
      retryAt: new Date(Date.now() + 5_000).toISOString(),
    });
    const manualStep = step();

    const result = await (processBackorderRetry as unknown as (args: any) => Promise<any>)({
      event: event("backorder/retry"),
      step: manualStep,
      runId: "manual-run-2",
    });

    expect(result).toMatchObject({ status: "resolved", retryCount: 1 });
    expect(manualStep.sleep).toHaveBeenCalledWith(
      "wait-for-backorder-lease-manual-retry:1-0",
      expect.stringMatching(/^\d+s$/)
    );
    expect(mocks.acquireLease).toHaveBeenCalledTimes(2);
    expect(mocks.createOutboundOrder).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("honors the global retry kill switch before credentials or provider work", async () => {
    mocks.backorderConfig.enabled = false;

    const [automatic, manual] = await Promise.all([
      (processBackorder as unknown as (args: any) => Promise<any>)({
        event: event("backorder/created"),
        step: step(),
        runId: "disabled-auto",
      }),
      (processBackorderRetry as unknown as (args: any) => Promise<any>)({
        event: event("backorder/retry"),
        step: step(),
        runId: "disabled-manual",
      }),
    ]);

    expect(automatic).toMatchObject({ status: "disabled", shopifyOrderId: "1001" });
    expect(manual).toMatchObject({ status: "disabled", shopifyOrderId: "1001" });
    expect(mocks.acquireLease).not.toHaveBeenCalled();
    expect(mocks.createOutboundOrder).not.toHaveBeenCalled();
  });
});
