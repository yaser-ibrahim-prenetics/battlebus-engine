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
  readPlan: vi.fn(async (): Promise<unknown> => null),
  processOrderSegments: vi.fn(async (input: unknown): Promise<unknown> => {
    void input;
    return null;
  }),
  loadOrderAccounting: vi.fn(async (): Promise<unknown> => ({})),
  loadSaudiShortAddress: vi.fn(async () => ""),
  loadEligibleRecoveryOrder: vi.fn(async (): Promise<unknown> => ({})),
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
vi.mock("@/lib/services/order-segments/store", () => ({ readPlan: mocks.readPlan }));
vi.mock("@/lib/services/order-segments/process", () => ({
  processOrderSegments: mocks.processOrderSegments,
}));
vi.mock("@/lib/services/order-accounting/load", () => ({
  loadOrderAccounting: mocks.loadOrderAccounting,
}));
vi.mock("@/lib/services/saudi-short-address", () => ({
  loadSaudiShortAddress: mocks.loadSaudiShortAddress,
}));
vi.mock("@/lib/services/order-segments/recovery", () => ({
  loadEligibleRecoveryOrder: mocks.loadEligibleRecoveryOrder,
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

function recordedStep(): ReturnType<typeof step> {
  const results = new Map<string, unknown>();
  return {
    run: vi.fn(async (name: string, execute: () => Promise<unknown>) => {
      if (results.has(name)) return results.get(name);
      const result = await execute();
      results.set(name, result);
      return result;
    }),
    sleep: vi.fn(async () => undefined),
  };
}

type BackorderHandler = (args: {
  event: ReturnType<typeof event>;
  step: ReturnType<typeof step>;
  runId: string;
}) => Promise<Record<string, unknown>>;

const automaticHandler = processBackorder as unknown as BackorderHandler;
const manualHandler = processBackorderRetry as unknown as BackorderHandler;

describe("backorder recovery serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backorderConfig.enabled = true;
    mocks.readPlan.mockResolvedValue(null);
    mocks.processOrderSegments.mockResolvedValue(null);
    mocks.loadOrderAccounting.mockResolvedValue({});
    mocks.loadSaudiShortAddress.mockResolvedValue("");
    mocks.loadEligibleRecoveryOrder.mockResolvedValue({});
  });

  it("registers created and manual retry events on separate workers", () => {
    expect(mocks.registrations).toHaveLength(2);
    expect(mocks.registrations[0].options.triggers).toEqual([{ event: "backorder/created" }]);
    expect(mocks.registrations[0].options.cancelOn).toEqual([
      {
        event: "backorder/resolved",
        if: "async.data.shopifyOrderId == event.data.shopifyOrderId && async.data.shopifyStore == event.data.shopifyStore",
      },
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
    const result = await manualHandler({
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
      expect.objectContaining({
        id: "backorder-retry:manual-retry-1:resolved",
        data: expect.objectContaining({ shopifyStore: "lease-test.myshopify.com" }),
      })
    );
  });

  it("keeps automatic retries on durable sleeps without consuming manual events", async () => {
    const automaticStep = step();
    const result = await automaticHandler({
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

    const result = await manualHandler({
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
      automaticHandler({
        event: event("backorder/created"),
        step: step(),
        runId: "disabled-auto",
      }),
      manualHandler({
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

  it("does not reacquire a segmented lease after its release step is replayed", async () => {
    const replayStep = recordedStep();
    mocks.readPlan.mockResolvedValue({
      plan: {
        inputHash: "segment-plan-hash",
        segments: [{ dataAreaId: "im8" }],
      },
    });
    mocks.loadEligibleRecoveryOrder.mockResolvedValue({ id: "1001", name: "#1001" });
    mocks.processOrderSegments.mockImplementation(async (rawInput: unknown) => {
      const input = rawInput as {
        step: ReturnType<typeof step>;
        beforeExternalMutation: () => Promise<unknown>;
      };
      return input.step.run("segment-provider-mutation", async () => {
        await input.beforeExternalMutation();
        return { status: "segmented" };
      });
    });
    const args = {
      event: event("backorder/retry"),
      step: replayStep,
      runId: "segment-replay-run",
    };

    await manualHandler(args);
    await manualHandler(args);

    expect(mocks.acquireLease).toHaveBeenCalledTimes(1);
    expect(mocks.renewLease).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
  });
});
