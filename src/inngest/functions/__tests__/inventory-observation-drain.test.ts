import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handler: null as null | ((args: { event: unknown; step: unknown }) => Promise<unknown>),
  submitOosDrainRequest: vi.fn(async () => ({ created: true })),
  features: { enableInventorySync: false, dryRunMode: false },
}));

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (_options: unknown, handler: typeof mocks.handler) => {
      mocks.handler = handler;
      return handler;
    },
  },
}));
vi.mock("@/lib/config", () => ({
  config: {
    features: mocks.features,
    oosRecovery: { enabled: true, claimBatchSize: 100 },
    csPlatform: { enabled: false },
    dynamics: { dataAreaId: "U001" },
  },
}));
vi.mock("@/lib/services/oos-recovery/requests", () => ({
  submitOosDrainRequest: mocks.submitOosDrainRequest,
}));
vi.mock("@/lib/services/flow-logs", () => ({ logFlowEvent: vi.fn() }));
vi.mock("@/lib/clients/hub-transport", () => ({ sendHubWebhook: vi.fn() }));
vi.mock("@/lib/clients/shopify-inventory", () => ({
  setInventoryItemAtLocation: vi.fn(),
  setSkuInventoryAtLocation: vi.fn(),
}));
vi.mock("@/lib/clients/dynamics", () => ({}));
vi.mock("@/lib/clients/gps", () => ({}));
vi.mock("@/lib/utils/constants", () => ({ RETRY_CONFIGS: { DEFAULT: 3 } }));

import { processInventoryMesh } from "../process-inventory-mesh";

function step() {
  return { run: vi.fn(async (_id: string, execute: () => Promise<unknown>) => execute()) };
}

function inventoryEvent(destination = "shopify") {
  return {
    id: "inventory-observation-1",
    data: {
      source: "gps",
      destination,
      payload: {
        inventoryKey: "gps:GPS-WAREHOUSE:SKU-1",
        sku: "SKU-1",
        available: 7,
        warehouseName: "GPS Warehouse",
        timestamp: "2026-10-29T00:00:00.000Z",
      },
    },
  };
}

const handler = processInventoryMesh as unknown as (args: {
  event: ReturnType<typeof inventoryEvent>;
  step: ReturnType<typeof step>;
}) => Promise<Record<string, unknown>>;

describe("inventory observations trigger targeted OOS drains", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.features.enableInventorySync = false;
  });

  it("queues the observation even when destination inventory synchronization is disabled", async () => {
    await expect(handler({ event: inventoryEvent(), step: step() })).resolves.toMatchObject({
      status: "skipped",
    });
    expect(mocks.submitOosDrainRequest).toHaveBeenCalledWith({
      mode: "inventory_event",
      dryRun: false,
      provider: "gps",
      warehouse: "GPS Warehouse",
      sku: "SKU-1",
      observedQuantity: 7,
      observedAt: "2026-10-29T00:00:00.000Z",
      sourceEventId: "inventory-observation-1",
      batchLimit: 100,
    });
  });

  it("queues the observation independently of an unsupported destination", async () => {
    mocks.features.enableInventorySync = true;
    await expect(
      handler({ event: inventoryEvent("unsupported"), step: step() })
    ).resolves.toMatchObject({ success: false });
    expect(mocks.submitOosDrainRequest).toHaveBeenCalledTimes(1);
  });
});
