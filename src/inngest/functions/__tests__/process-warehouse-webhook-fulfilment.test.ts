import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "@/lib/config";
import type { IShopifyFulfillmentOrder } from "@/lib/types/shopify";
import { loadFixture } from "../../../../tests/fixtures";
import { createInngestHarness } from "../../../../tests/helpers/inngest-harness";
import { runProcessWarehouseWebhookFulfilment } from "../process-warehouse-webhook-fulfilment";

const shopifyMocks = vi.hoisted(() => ({
  getOrder: vi.fn(),
  searchOrdersByName: vi.fn(),
  getFulfillmentOrders: vi.fn(),
  createFulfillment: vi.fn(),
}));

const locationMocks = vi.hoisted(() => ({
  getLocationIdForWarehouse: vi.fn(),
  stordWarehouseNameForShipCountry: vi.fn(),
}));

vi.mock("@/lib/clients/shopify", () => shopifyMocks);
vi.mock("@/lib/services/location-routing", () => locationMocks);

function openFulfillmentOrder(order: ReturnType<typeof loadFixture>, locationId: number) {
  const item = order.line_items[0];
  return {
    id: 9001,
    status: "open",
    assigned_location_id: locationId,
    assigned_location: { location_id: locationId },
    line_items: [
      {
        id: 9101,
        line_item_id: item.id,
        fulfillment_order_id: 9001,
        fulfillable_quantity: item.quantity,
        quantity: item.quantity,
        variant_id: item.variant_id || 0,
      },
    ],
  } as unknown as IShopifyFulfillmentOrder;
}

function setFeatureFlags(
  flags: Partial<
    Pick<
      typeof config.features,
      "enableGpsSync" | "enableStordSync" | "enableShopifyFulfillmentWriteback" | "dryRunMode"
    >
  >
) {
  Object.assign(config.features, flags);
}

describe("processWarehouseWebhookFulfilment", () => {
  const originalGpsEnabled = config.features.enableGpsSync;
  const originalStordEnabled = config.features.enableStordSync;
  const originalWriteback = config.features.enableShopifyFulfillmentWriteback;
  const originalDryRun = config.features.dryRunMode;

  beforeEach(() => {
    vi.clearAllMocks();
    setFeatureFlags({
      enableGpsSync: true,
      enableStordSync: true,
      enableShopifyFulfillmentWriteback: false,
      dryRunMode: false,
    });
    locationMocks.stordWarehouseNameForShipCountry.mockReturnValue("STORD ATL Location");
  });

  afterEach(() => {
    setFeatureFlags({
      enableGpsSync: originalGpsEnabled,
      enableStordSync: originalStordEnabled,
      enableShopifyFulfillmentWriteback: originalWriteback,
      dryRunMode: originalDryRun,
    });
  });

  it("consumes GPS pushes and dispatches the canonical fulfillment flow", async () => {
    const order = loadFixture("gpsUsOrder");
    const item = order.line_items[0];
    const locationId = 79527313640;
    const harness = createInngestHarness();
    shopifyMocks.getOrder.mockResolvedValue(order);
    shopifyMocks.getFulfillmentOrders.mockResolvedValue([openFulfillmentOrder(order, locationId)]);
    locationMocks.getLocationIdForWarehouse.mockResolvedValue(String(locationId));

    const result = await runProcessWarehouseWebhookFulfilment({
      event: {
        id: "gps-event-1",
        name: "gps/fulfilment.received",
        data: {
          gpsOrderId: "GPS-1001",
          shopifyOrderId: String(order.id),
          trackingNumber: "GPS-TRACK-1",
          carrierCode: "FEDEX",
          receivedAt: "2026-09-28T08:00:00.000Z",
          fulfilmentJson: {
            orderId: "GPS-1001",
            orderNumber: order.name,
            warehouse: "GPS Warehouse",
            shippedDate: "2026-09-28T07:59:00.000Z",
            items: [{ sku: item.sku, quantity: 1 }],
          },
        },
      },
      step: harness.step,
    });

    expect(result).toMatchObject({
      status: "queued",
      source: "gps",
      shopifyOrderId: String(order.id),
      warehouseName: "GPS Warehouse",
      shopifyWriteback: "disabled",
    });
    expect(shopifyMocks.createFulfillment).not.toHaveBeenCalled();
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      name: "shopify/order.fulfilled",
      data: {
        shopifyOrderId: String(order.id),
        shopifyOrderName: order.name,
        fromGpsSync: true,
        fromWarehouseWebhook: true,
        warehouseWebhookSource: "gps",
      },
    });
    expect(harness.events[0].data.fulfillments[0]).toMatchObject({
      location_id: locationId,
      tracking_number: "GPS-TRACK-1",
      tracking_company: "FedEx",
      line_items: [{ id: item.id, sku: item.sku, quantity: 1 }],
    });
  });

  it("creates a Shopify fulfillment for a new STORD shipment before dispatching D365 sync", async () => {
    const order = loadFixture("stordOrder");
    const item = order.line_items[0];
    const locationId = 83243204840;
    const harness = createInngestHarness();
    setFeatureFlags({ enableShopifyFulfillmentWriteback: true });
    shopifyMocks.getOrder.mockResolvedValue(order);
    shopifyMocks.getFulfillmentOrders.mockResolvedValue([openFulfillmentOrder(order, locationId)]);
    shopifyMocks.createFulfillment.mockResolvedValue({
      id: 7001,
      created_at: "2026-09-28T08:00:00.000Z",
      updated_at: "2026-09-28T08:00:01.000Z",
    });
    locationMocks.getLocationIdForWarehouse.mockResolvedValue(String(locationId));

    const result = await runProcessWarehouseWebhookFulfilment({
      event: {
        name: "stord/fulfilment.received",
        data: {
          stordOrderId: "STORD-2001",
          shopifyOrderId: String(order.id),
          trackingNumber: "STORD-TRACK-1",
          carrierCode: "UPS",
          fulfilmentJson: {
            orderId: "STORD-2001",
            orderNumber: order.name,
            warehouseName: "STORD ATL Location",
            lineItems: [{ sku: item.sku, quantity: 1 }],
          },
        },
      },
      step: harness.step,
    });

    expect(result).toMatchObject({
      status: "queued",
      source: "stord",
      warehouseName: "STORD ATL Location",
      shopifyWriteback: "created",
    });
    expect(shopifyMocks.createFulfillment).toHaveBeenCalledTimes(1);
    expect(shopifyMocks.createFulfillment).toHaveBeenCalledWith(
      9001,
      expect.objectContaining({ number: "STORD-TRACK-1", company: "UPS" }),
      [{ id: 9101, quantity: 1 }],
      "stord_webhook",
      "STORD",
      { notifyCustomer: true }
    );
    expect(harness.events[0]).toMatchObject({
      name: "shopify/order.fulfilled",
      data: {
        fromGpsSync: false,
        fromWarehouseWebhook: true,
        warehouseWebhookSource: "stord",
      },
    });
    expect(harness.events[0].data.fulfillments[0].id).toBe(7001);
  });

  it("does not duplicate Shopify writeback when the tracking number already exists", async () => {
    const order = loadFixture("stordOrder");
    const item = order.line_items[0];
    const locationId = 83243204840;
    const harness = createInngestHarness();
    setFeatureFlags({ enableShopifyFulfillmentWriteback: true });
    shopifyMocks.getOrder.mockResolvedValue({
      ...order,
      fulfillments: [
        {
          id: 7002,
          order_id: order.id,
          status: "success",
          created_at: "2026-09-28T08:00:00.000Z",
          updated_at: "2026-09-28T08:00:01.000Z",
          tracking_company: "UPS",
          tracking_number: "STORD-TRACK-EXISTING",
          tracking_numbers: ["STORD-TRACK-EXISTING"],
          tracking_url: null,
          tracking_urls: [],
          location_id: locationId,
          line_items: [],
        },
      ],
    });
    locationMocks.getLocationIdForWarehouse.mockResolvedValue(String(locationId));

    const result = await runProcessWarehouseWebhookFulfilment({
      event: {
        name: "stord/fulfilment.received",
        data: {
          stordOrderId: "STORD-2002",
          shopifyOrderId: String(order.id),
          trackingNumber: "STORD-TRACK-EXISTING",
          carrierCode: "UPS",
          fulfilmentJson: {
            orderId: "STORD-2002",
            orderNumber: order.name,
            lineItems: [{ sku: item.sku, quantity: 1 }],
          },
        },
      },
      step: harness.step,
    });

    expect(result.shopifyWriteback).toBe("already_fulfilled");
    expect(shopifyMocks.getFulfillmentOrders).not.toHaveBeenCalled();
    expect(shopifyMocks.createFulfillment).not.toHaveBeenCalled();
    expect(harness.events[0].data.fulfillments[0].id).toBe(7002);
  });

  it("consumes but safely skips GPS webhooks while GPS sync is disabled", async () => {
    const harness = createInngestHarness();
    setFeatureFlags({ enableGpsSync: false });

    const result = await runProcessWarehouseWebhookFulfilment({
      event: {
        name: "gps/fulfilment.received",
        data: {
          gpsOrderId: "GPS-1002",
          shopifyOrderId: "123",
          trackingNumber: "GPS-TRACK-2",
        },
      },
      step: harness.step,
    });

    expect(result).toEqual({ status: "skipped", source: "gps", reason: "gps_sync_disabled" });
    expect(shopifyMocks.getOrder).not.toHaveBeenCalled();
    expect(harness.events).toHaveLength(0);
  });
});
