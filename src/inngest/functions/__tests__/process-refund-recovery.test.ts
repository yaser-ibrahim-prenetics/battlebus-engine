import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveD365OrderHeaderForRefundWithAudit } from "@/lib/services/d365-refund-order-resolution";
import {
  acceptRefundRecovery,
  deferRefundUntilOrder,
  reserveRefundOperation,
} from "@/lib/services/refund-operations";
import { processRefund } from "../process-refund";

vi.mock("@/lib/config", () => ({
  config: {
    features: {
      dryRunMode: false,
      enableDynamicsSync: true,
      enableReturnInvoicePosting: false,
    },
    loop: { enabled: false },
    dynamics: { dataAreaId: "U001" },
  },
}));

vi.mock("../../client", () => ({
  inngest: {
    createFunction: vi.fn((_options, handler) => handler),
  },
}));

vi.mock("@/lib/clients/shopify", () => ({
  getOrder: vi.fn(async () => ({
    id: "1001",
    name: "#IM8-1001",
    currency: "USD",
    total_price: "10.00",
    shipping_address: { country_code: "US" },
  })),
}));
vi.mock("@/lib/clients/dynamics", () => ({}));
vi.mock("@/lib/clients/slack", () => ({}));
vi.mock("@/lib/clients/cs-platform", () => ({}));
vi.mock("@/lib/helpers/warehouse", () => ({}));
vi.mock("@/lib/helpers/exchange", () => ({}));
vi.mock("@/lib/services/order-lines", () => ({ saveRefundOrderLine: vi.fn() }));
vi.mock("@/lib/services/shopify-loop-refund-detection", () => ({
  shopifyRefundCreatedByLoopReturns: vi.fn(async () => false),
}));
vi.mock("@/lib/utils/d365-odata-trace", () => ({
  logRefundTraceLifecycle: vi.fn(),
}));
vi.mock("@/lib/services/flow-logs", () => ({ logFlowEvent: vi.fn() }));
vi.mock("@/lib/services/d365-refund-order-resolution", () => ({
  resolveD365OrderHeaderForRefundWithAudit: vi.fn(),
}));
vi.mock("@/lib/services/refund-operations", () => ({
  acceptRefundRecovery: vi.fn(),
  completeRefundOperation: vi.fn(),
  deferRefundUntilOrder: vi.fn(),
  markRefundLineCreated: vi.fn(),
  reserveRefundOperation: vi.fn(),
}));

const handler = processRefund as unknown as (input: {
  event: { data: Record<string, unknown> };
  step: { run: (name: string, callback: () => unknown) => Promise<unknown> };
  runId: string;
}) => Promise<Record<string, unknown>>;

function refundEvent(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      shopifyOrderId: "1001",
      refundId: "refund-42",
      shopifyStore: "test.myshopify.com",
      refundJson: { id: "refund-42", transactions: [] },
      receivedAt: "2026-09-29T00:00:00.000Z",
      ...overrides,
    },
  };
}

function immediateStep() {
  return {
    run: vi.fn(async (_name: string, callback: () => unknown) => callback()),
  };
}

describe("processRefund database recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveD365OrderHeaderForRefundWithAudit).mockResolvedValue({
      header: null,
      audit: {} as never,
    });
    vi.mocked(deferRefundUntilOrder).mockResolvedValue(undefined);
  });

  it("stores a missing-order refund in the recovery ledger", async () => {
    vi.mocked(reserveRefundOperation).mockResolvedValue({
      claimed: true,
      state: "processing",
      claimToken: "00000000-0000-0000-0000-000000000099",
    });

    const result = await handler({
      event: refundEvent(),
      step: immediateStep(),
      runId: "run-1",
    });

    expect(deferRefundUntilOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        refundId: "refund-42",
        claimToken: "00000000-0000-0000-0000-000000000099",
        eventName: "shopify/refund.created",
      })
    );
    expect(result).toMatchObject({ status: "deferred", refundId: "refund-42" });
  });

  it("accepts only the database lease attached to a recovery event", async () => {
    vi.mocked(acceptRefundRecovery).mockResolvedValue({
      claimed: true,
      state: "processing",
      claimToken: "00000000-0000-0000-0000-000000000088",
    });

    await handler({
      event: refundEvent({
        refundRecoveryToken: "00000000-0000-0000-0000-000000000088",
        refundRecoveryAttempt: 2,
      }),
      step: immediateStep(),
      runId: "run-2",
    });

    expect(acceptRefundRecovery).toHaveBeenCalledWith({
      refundId: "refund-42",
      claimToken: "00000000-0000-0000-0000-000000000088",
    });
    expect(reserveRefundOperation).not.toHaveBeenCalled();
  });

  it("stops a duplicate before any D365 lookup", async () => {
    vi.mocked(reserveRefundOperation).mockResolvedValue({
      claimed: false,
      state: "completed",
      claimToken: null,
    });

    const result = await handler({
      event: refundEvent(),
      step: immediateStep(),
      runId: "run-3",
    });

    expect(result).toMatchObject({ status: "already_processed" });
    expect(resolveD365OrderHeaderForRefundWithAudit).not.toHaveBeenCalled();
    expect(deferRefundUntilOrder).not.toHaveBeenCalled();
  });
});
