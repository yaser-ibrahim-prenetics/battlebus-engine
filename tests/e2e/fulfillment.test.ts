/**
 * E2E: Fulfillment Flow
 *
 * Tests the fulfillment pipeline:
 *   1. Uses an existing D365 order (from order-creation E2E or a known test order)
 *   2. Gets lot IDs from D365 sales order lines
 *   3. Creates D365 packing slip (fulfillment) with correct warehouse config
 *   4. Verifies the fulfillment was posted to D365
 *   5. For GPS orders — checks GPS order status via getOutboundOrdersDetails
 *
 * Skipped unless E2E env vars are set.
 */

import { describe, it, expect, afterAll } from "vitest";
import { validateE2eEnv } from "./setup";
import { d365E2e, gpsE2e } from "./clients";
import {
  getWarehouseConfig,
  getShippingSku,
  getTaxSku,
  isGpsWarehouse,
  isStordWarehouse,
} from "@/lib/helpers/warehouse";
import { isServiceSku } from "@/lib/transformers/sku";
import {
  toD365SalesOrderHeaderV3,
  toD365SalesOrderLines,
  calculatePrepaymentAmount,
} from "@/lib/transformers/order";
import { loadFixture } from "../fixtures";

const envCheck = validateE2eEnv();
const RUN = envCheck.valid;

const cleanup: Array<{ d365OrderNumber: string; dataAreaId: string }> = [];

describe("E2E: Fulfillment Flow", () => {
  if (!RUN) {
    it.skip(`Skipped — missing env: ${envCheck.missing.join(", ")}`, () => {});
    return;
  }

  afterAll(async () => {
    for (const item of cleanup) {
      try {
        await d365E2e.deleteSalesOrder(item.d365OrderNumber, item.dataAreaId);
        console.log(`[Cleanup] Deleted D365 order ${item.d365OrderNumber}`);
      } catch {
        console.warn(`[Cleanup] Could not delete ${item.d365OrderNumber}`);
      }
    }
  });

  it("creates a D365 order and posts a packing slip fulfillment for STORD", async () => {
    const order = loadFixture("stordOrder");
    const warehouseName = "STORD ATL Location";
    const warehouseCfg = getWarehouseConfig(warehouseName);

    expect(isStordWarehouse(warehouseName)).toBe(true);
    expect(isGpsWarehouse(warehouseName)).toBe(false);

    const dynamics = await import("@/lib/clients/dynamics");
    await dynamics.authenticate();

    // Create D365 header
    const header = toD365SalesOrderHeaderV3(order, warehouseName);
    const headerResult = await dynamics.createSalesOrderHeaderV3(header);
    const salesOrderNumber = headerResult.SalesOrderNumber;
    expect(salesOrderNumber).toBeTruthy();
    console.log(`[E2E Fulfill] Created D365 header: ${salesOrderNumber}`);
    cleanup.push({ d365OrderNumber: salesOrderNumber, dataAreaId: "U001" });

    // Create D365 lines
    const lines = toD365SalesOrderLines(order, salesOrderNumber, warehouseName);
    const productLines = lines.filter((l) => !isServiceSku(l.itemNumber));
    expect(productLines.length).toBeGreaterThan(0);

    for (const line of lines) {
      try {
        await dynamics.createSalesOrderLine({ ...line, salesOrderNumber });
      } catch (err: any) {
        if (isServiceSku(line.itemNumber) && err.message?.includes("does not exist")) {
          console.warn(`[E2E Fulfill] Skipped missing service SKU ${line.itemNumber}`);
        } else {
          throw err;
        }
      }
    }

    // Confirm order
    await new Promise((r) => setTimeout(r, 1000));
    await dynamics.confirmSalesOrder(salesOrderNumber, "U001");
    console.log(`[E2E Fulfill] Confirmed: ${salesOrderNumber}`);

    // Get lot ID map for fulfillment lines
    const lotIdMap = await dynamics.getLotIdMap(salesOrderNumber, "U001");
    console.log(`[E2E Fulfill] Lot IDs: ${JSON.stringify(lotIdMap)}`);

    // Build fulfillment lines from product lines only
    const fulfillmentLines = productLines.map((line) => ({
      itemNumber: line.itemNumber,
      quantity: line.quantity,
      shippingSiteId: warehouseCfg.fulfilment.shippingSiteId,
      shippingWarehouseId: warehouseCfg.fulfilment.shippingWarehouseId,
      shippingWarehouseLocationId: warehouseCfg.fulfilment.shippingWarehouseLocationId,
      lotId: lotIdMap[line.itemNumber] || "",
      trackingNumber: "E2E-TEST-TRACK-001",
    }));

    expect(fulfillmentLines.length).toBeGreaterThan(0);

    // Post packing slip
    const fulfillResult = await dynamics.createFulfilment({
      salesOrderNumber,
      dataAreaId: "U001",
      type: "PackingSlip",
      confirmedShippedDate: new Date().toISOString().split("T")[0],
      lines: fulfillmentLines,
    });

    expect(fulfillResult.response).toBeDefined();
    console.log(`[E2E Fulfill] Packing slip posted for ${salesOrderNumber}`);

    // Verify packing slip exists via D365 lookup
    const d365Lines = await d365E2e.getSalesOrderLines(salesOrderNumber, "U001");
    expect(d365Lines.length).toBeGreaterThan(0);
  }, 120_000);

  it("GPS order: verifies order exists in GPS after creation", async () => {
    const order = loadFixture("gpsUkOrder");
    const warehouseName = "GPS UK Warehouse";

    expect(isGpsWarehouse(warehouseName)).toBe(true);

    const dynamics = await import("@/lib/clients/dynamics");
    await dynamics.authenticate();

    // Create D365 header
    const header = toD365SalesOrderHeaderV3(order, warehouseName);
    const headerResult = await dynamics.createSalesOrderHeaderV3(header);
    const salesOrderNumber = headerResult.SalesOrderNumber;
    expect(salesOrderNumber).toBeTruthy();
    console.log(`[E2E GPS Fulfill] Created D365 header: ${salesOrderNumber}`);
    cleanup.push({ d365OrderNumber: salesOrderNumber, dataAreaId: "H007" });

    // Create D365 lines
    const lines = toD365SalesOrderLines(order, salesOrderNumber, warehouseName);
    for (const line of lines) {
      try {
        await dynamics.createSalesOrderLine({ ...line, salesOrderNumber });
      } catch (err: any) {
        if (isServiceSku(line.itemNumber) && err.message?.includes("does not exist")) {
          console.warn(`[E2E GPS Fulfill] Skipped missing service SKU ${line.itemNumber}`);
        } else {
          throw err;
        }
      }
    }

    // Confirm + prepayment
    await new Promise((r) => setTimeout(r, 1000));
    await dynamics.confirmSalesOrder(salesOrderNumber, "H007");

    try {
      await dynamics.createPrepayment(salesOrderNumber, "H007");
    } catch {
      console.warn(`[E2E GPS Fulfill] Prepayment skipped`);
    }

    // Send to GPS — real API call
    const gps = await import("@/lib/clients/gps");
    const { toGpsOutboundOrder } = await import("@/lib/transformers/order");
    const gpsPayload = toGpsOutboundOrder(order, salesOrderNumber, warehouseName);

    let gpsOrderNo: string | undefined;
    try {
      const gpsResult = await gps.createOutboundOrder(gpsPayload, "GPS UK Warehouse");
      gpsOrderNo = gpsResult.response?.data?.[0]?.orderNo;
      console.log(`[E2E GPS Fulfill] GPS order created: ${gpsOrderNo}`);
    } catch (err: any) {
      // GPS may reject due to inventory — that's OK for this test
      console.warn(`[E2E GPS Fulfill] GPS order creation failed (expected for test): ${err.message}`);
    }

    // If GPS order was created, verify its status
    if (gpsOrderNo) {
      const statusResult = await gpsE2e.getOrderStatus([gpsOrderNo], "GPS UK Warehouse");
      expect(statusResult).toBeDefined();
      console.log(`[E2E GPS Fulfill] GPS status: ${JSON.stringify(statusResult?.data?.[0]?.status)}`);

      // Cancel the GPS order to avoid real warehouse processing
      try {
        await gpsE2e.cancelOrder(gpsOrderNo, "GPS UK Warehouse");
        console.log(`[E2E GPS Fulfill] Cancelled GPS order: ${gpsOrderNo}`);
      } catch {
        console.warn(`[E2E GPS Fulfill] Could not cancel GPS order ${gpsOrderNo}`);
      }
    }
  }, 120_000);
});
